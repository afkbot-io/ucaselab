"""One application boundary shared by the browser API and MCP tools."""

import hashlib
import hmac
import inspect
from dataclasses import dataclass
from typing import Any, TypeVar, get_type_hints

from fastapi.encoders import jsonable_encoder
from pydantic import ConfigDict, ValidationError, create_model
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from . import models as m
from .db import Base
from .security import ROLE_RANK, Actor, content_hash, fail, membership

ModelT = TypeVar("ModelT", bound=Base)


@dataclass
class Context:
    """Per-call transaction and actor. Project-only helpers reject global contexts."""

    db: Session
    actor: Actor
    project: m.Project | None = None
    member: m.Membership | None = None

    @property
    def user_id(self) -> str:
        return self.actor.user.id

    @property
    def project_id(self) -> str:
        if self.project is None:
            fail("PROJECT_REQUIRED", "Укажите проект")
        return self.project.id

    @property
    def qa(self) -> bool:
        return self.member is not None and ROLE_RANK[self.member.role] >= 1

    def require(self, role: str = "tester") -> None:
        if self.member is None or ROLE_RANK[self.member.role] < ROLE_RANK[role]:
            fail("FORBIDDEN", "Недостаточно прав для этого действия", 403)

    def get(self, model: type[ModelT], object_id: str, archived: bool = True) -> ModelT:
        """Load within this project; archived=True permits reading archived objects."""
        obj = self.db.get(model, object_id)
        if not obj or (hasattr(obj, "project_id") and getattr(obj, "project_id") != self.project_id):
            fail("NOT_FOUND", "Объект не найден в проекте", 404)
        if not archived and getattr(obj, "archived", False):
            fail("OBJECT_ARCHIVED", "Объект в архиве", 409)
        if isinstance(obj, m.Run) and obj.case_source == "draft" and not self.qa:
            fail("NOT_FOUND", "Прогон не найден", 404)
        if isinstance(obj, m.Attachment) and not self.qa:
            execution = self.db.get(m.Execution, obj.execution_id)
            item = self.db.get(m.RunItem, execution.run_item_id) if execution else None
            if item:
                self.get(m.Run, item.run_id)
        return obj

    def audit(self, action, resource_id=None, metadata=None):
        self.db.add(
            m.Audit(
                project_id=self.project_id,
                actor_id=self.user_id,
                action=action,
                resource_id=resource_id,
                metadata_={
                    **(metadata or {}),
                    "source": "mcp" if self.actor.token else "web",
                    **({"credential_id": self.actor.token.id} if self.actor.token else {}),
                },
            )
        )

    def expect(self, obj, expected_version):
        if obj.version != expected_version:
            fail("VERSION_CONFLICT", "Объект изменился. Обновите страницу и сравните изменения", 409)


REGISTRY: dict[str, dict[str, Any]] = {}


def operation(scope="projects:read", role="developer", write=False, global_=False, archived=False):
    def decorate(func):
        hints = get_type_hints(func, include_extras=True)
        fields: dict[str, Any] = {}
        for name, param in inspect.signature(func).parameters.items():
            if name == "ctx":
                continue
            fields[name] = (
                hints.get(name, str),
                ... if param.default is inspect.Parameter.empty else param.default,
            )
        model = create_model(func.__name__ + "Input", __config__=ConfigDict(extra="forbid"), **fields)
        REGISTRY[func.__name__] = dict(
            func=func, model=model, scope=scope, role=role, write=write, global_=global_, archived=archived
        )
        return func

    return decorate


def dispatch(db, actor, name, project_id=None, arguments=None, idempotency_key=None):
    op = REGISTRY.get(name)
    if not op:
        fail("UNKNOWN_OPERATION", "Неизвестная операция", 404)
    actor.scope(op["scope"])
    ctx = Context(db, actor)
    if not op["global_"]:
        if not project_id:
            fail("PROJECT_REQUIRED", "Укажите проект")
        ctx.member = membership(db, actor, project_id, op["role"], allow_archived=op["archived"])
        # Serialize mutations inside a project; snapshots and publication counters stay atomic.
        query = select(m.Project).where(m.Project.id == project_id)
        if op["write"]:
            query = query.with_for_update().execution_options(populate_existing=True)
        ctx.project = db.scalar(query)
        if op["write"]:
            # Another writer may have changed membership or ownership while we waited.
            ctx.member = membership(db, actor, project_id, op["role"], allow_archived=op["archived"])
    try:
        values = op["model"].model_validate(arguments or {})
    except ValidationError as exc:
        fail(
            "VALIDATION_ERROR",
            "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()),
            422,
        )
    key = None
    from .config import settings
    from .security import canonical

    request_hash = hmac.new(
        settings().secret_key.encode(),
        canonical(
            {"operation": name, "project_id": project_id, "arguments": values.model_dump(mode="json")}
        ).encode(),
        hashlib.sha256,
    ).hexdigest()

    if idempotency_key and (not op["write"] or name == "reveal_test_account_secret"):
        fail("NOT_CACHEABLE", "Эта операция не поддерживает кэш повторного запроса")
    if idempotency_key:
        if len(idempotency_key) > 100:
            fail("INVALID_IDEMPOTENCY_KEY", "Ключ слишком длинный")
        key = f"{actor.user.id}:{project_id}:{idempotency_key}"
        if db.bind.dialect.name == "postgresql":
            db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": int(content_hash(key)[:15], 16)})
        previous = db.get(m.Idempotency, key)
        if previous:
            if previous.request_hash != request_hash:
                fail("IDEMPOTENCY_CONFLICT", "Этот ключ уже использован для другого запроса", 409)
            return previous.response
    # Pydantic models must stay typed when passed into operation handlers.
    result = op["func"](ctx, **{field: getattr(values, field) for field in values.__class__.model_fields})
    result = jsonable_encoder(result)
    if key:
        db.add(m.Idempotency(key=key, request_hash=request_hash, response=result))
    db.flush()
    return result


def rows(ctx, model, archived=False):
    query = select(model).where(model.project_id == ctx.project_id)
    if hasattr(model, "archived"):
        query = query.where(model.archived == archived)
    return ctx.db.scalars(query.order_by(model.created_at)).all()


def fields(obj, *names):
    return {name: getattr(obj, name) for name in ("id", "created_at", *names)}


def notify(ctx, event, title, resource_type, resource_id, user_ids=None, qa_only=False):
    from .config import settings

    members = ctx.db.scalars(select(m.Membership).where(m.Membership.project_id == ctx.project_id)).all()
    recipients = set(user_ids or [])
    if user_ids is None:
        recipients.update(x.user_id for x in members if ROLE_RANK[x.role] >= (1 if qa_only else 0))
    subscriptions = ctx.db.scalars(
        select(m.Subscription).where(
            m.Subscription.project_id == ctx.project_id,
            m.Subscription.resource_type == resource_type,
            m.Subscription.resource_id == resource_id,
        )
    ).all()
    muted = {s.user_id for s in subscriptions if s.level == "muted"}
    eligible = {x.user_id for x in members if not qa_only or ROLE_RANK[x.role] >= 1}
    for user_id in (recipients & eligible) - muted - {ctx.user_id}:
        user = ctx.db.get(m.User, user_id)
        preferences = user.preferences.get(ctx.project_id, {})
        if preferences.get(event, True) is False:
            continue
        notification = m.Notification(
            project_id=ctx.project_id,
            user_id=user_id,
            event=event,
            title=title[:240],
            resource_type=resource_type,
            resource_id=resource_id,
        )
        ctx.db.add(notification)
        ctx.db.flush()
        if settings().email_enabled and preferences.get("email", False):
            # Only a notification ID enters the outbox. Membership is checked again at delivery.
            ctx.db.add(m.Outbox(kind="notification_email", payload={"notification_id": notification.id}))
