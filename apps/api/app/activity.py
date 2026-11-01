"""A permission-filtered projection of the existing audit, with explicit personal receipts."""

from datetime import datetime
from typing import Annotated

from pydantic import Field
from sqlalchemy import and_, case, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert

from . import models as m
from .discussion_targets import target_visible
from .operations import operation
from .security import fail

PageSize = Annotated[int, Field(ge=1, le=100)]
EventIds = Annotated[list[str], Field(max_length=100)]


def activity_query(ctx, all_projects=False):
    a, member, thread = m.Audit, m.Membership, m.Thread
    kind = case(
        (a.action.like("discussion.%"), "thread"),
        (a.action.like("use_cases.%"), "use_case"),
        (a.action.like("specifications.%"), "specification"),
        (a.action.like("case_plans.%"), "plan"),
        *[
            (a.action.like(prefix + ".%"), prefix)
            for prefix in (
                "use_case",
                "proposal",
                "specification",
                "execution",
                "run",
                "report",
                "plan",
            )
        ],
        else_="",
    )
    target_kind = case((kind == "thread", thread.target_type), else_=kind)
    target_id = case(
        (kind == "thread", func.coalesce(thread.target_id, thread.use_case_id)), else_=a.resource_id
    )
    qa = member.role != "developer"
    # Own actions are already known to their author, including legacy audit rows.
    read = or_(
        a.actor_id == ctx.user_id,
        exists().where(m.ActivityRead.event_id == a.id, m.ActivityRead.user_id == ctx.user_id),
    )
    query = (
        select(
            a,
            kind.label("entity_type"),
            target_kind.label("target_type"),
            target_id.label("target_id"),
            read.label("read"),
            m.User.name.label("actor_name"),
            m.RunItem.run_id,
            m.RunItem.id.label("run_item_id"),
        )
        .join(member, and_(member.project_id == a.project_id, member.user_id == ctx.user_id))
        .join(m.Project, m.Project.id == a.project_id)
        .join(m.User, m.User.id == a.actor_id)
        .outerjoin(
            thread, and_(kind == "thread", thread.id == a.resource_id, thread.project_id == a.project_id)
        )
        .outerjoin(m.Execution, and_(target_kind == "execution", m.Execution.id == target_id))
        .outerjoin(m.RunItem, m.RunItem.id == m.Execution.run_item_id)
        .where(
            m.Project.archived == False,
            # A published case does not make its unpublished revision activity public.
            or_(qa, m.Audit.action.not_in(["use_case.draft_saved", "use_case.revision_restored"])),
            or_(kind != "thread", qa, thread.visibility != "qa_team"),
            target_visible(target_kind, target_id, a.project_id, qa, ctx.user_id),
        )
    )
    if not all_projects:
        query = query.where(a.project_id == ctx.project_id)
    if ctx.actor.token:
        query = query.where(a.project_id.in_(ctx.actor.token.project_ids))
    return query


def activity_unread(ctx):
    q = activity_query(ctx).subquery()
    return ctx.db.scalar(select(func.count()).select_from(q).where(q.c.read == False))


def event_path(row):
    a, kind, target_kind, target_id, _, _, run_id, run_item_id = row
    sections = {
        "use_case": "cases",
        "proposal": "proposals",
        "specification": "specifications",
        "report": "reports",
        "run": "runs",
        "plan": "plans",
    }
    base = f"/p/{a.project_id}"
    if target_kind == "execution":
        path = f"{base}/runs/{run_id}?check={run_item_id}&execution={target_id}"
    elif target_kind == "specification":
        path = f"{base}/specifications?open={target_id}"
    else:
        path = f"{base}/{sections[target_kind]}/{target_id}"
    if kind == "thread":
        path += ("&" if "?" in path else "?") + "thread=" + a.resource_id
    return path


@operation("notifications:read")
def list_activity(
    ctx,
    all_projects: bool = False,
    entity_type: str | None = None,
    event_type: str | None = None,
    actor_id: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    unread: bool | None = None,
    before: str | None = None,
    limit: PageSize = 30,
):
    """История доступных бизнес-изменений: фильтры, стабильный курсор, личное чтение. Открытие списка ничего не отмечает."""
    query = activity_query(ctx, all_projects)
    if entity_type:
        query = query.where(query.selected_columns.entity_type == entity_type)
    if event_type:
        aliases = [event_type]
        for singular, plural in [
            ("use_case", "use_cases"),
            ("specification", "specifications"),
            ("plan", "case_plans"),
        ]:
            if event_type.startswith(singular + "."):
                aliases.append(event_type.replace(singular + ".", plural + ".", 1))
        query = query.where(m.Audit.action.in_(aliases))
    if actor_id:
        query = query.where(m.Audit.actor_id == actor_id)
    if since:
        query = query.where(m.Audit.created_at >= since)
    if until:
        query = query.where(m.Audit.created_at <= until)
    sub = query.subquery()
    unread_count = ctx.db.scalar(select(func.count()).select_from(sub).where(sub.c.read == False))
    if unread is not None:
        query = query.where(query.selected_columns.read == (not unread))
    if before:
        try:
            at, event_id = before.split("|", 1)
            stamp = datetime.fromisoformat(at)
            if len(event_id) != 36:
                raise ValueError
        except ValueError:
            fail("INVALID_CURSOR", "Неверный курсор истории")
        query = query.where(
            or_(m.Audit.created_at < stamp, and_(m.Audit.created_at == stamp, m.Audit.id < event_id))
        )
    rows = ctx.db.execute(query.order_by(m.Audit.created_at.desc(), m.Audit.id.desc()).limit(limit + 1)).all()
    items = [
        {
            "id": r[0].id,
            "created_at": r[0].created_at,
            "project_id": r[0].project_id,
            "actor_id": r[0].actor_id,
            "actor_name": r.actor_name,
            "event_type": r[0]
            .action.replace("use_cases.", "use_case.")
            .replace("specifications.", "specification.")
            .replace("case_plans.", "plan."),
            "entity_type": r.entity_type,
            "resource_id": r[0].resource_id,
            "read": r.read,
            "path": event_path(r),
        }
        for r in rows[:limit]
    ]
    actors = ctx.db.execute(
        activity_query(ctx, all_projects).with_only_columns(m.Audit.actor_id, m.User.name).distinct()
    ).all()
    return {
        "items": items,
        "actors": [{"id": a, "name": n} for a, n in actors],
        "unread_count": unread_count,
        "next_cursor": f"{items[-1]['created_at'].isoformat()}|{items[-1]['id']}"
        if len(rows) > limit
        else None,
    }


@operation("notifications:write", write=True)
def mark_activity_read(ctx, event_ids: EventIds, all_projects: bool = False):
    """Отметить только явно переданные доступные события; повтор безопасен, новые события остаются непрочитанными."""
    ids = ctx.db.scalars(
        activity_query(ctx, all_projects).with_only_columns(m.Audit.id).where(m.Audit.id.in_(event_ids))
    ).all()
    if ids:
        ctx.db.execute(
            insert(m.ActivityRead)
            .values([{"event_id": event_id, "user_id": ctx.user_id, "read_at": m.now()} for event_id in ids])
            .on_conflict_do_nothing()
        )
    return {"ok": True}
