import base64
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, NoReturn

from argon2 import PasswordHasher
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .config import settings
from .models import ApiToken, Membership, Project, RateBucket, Session, User, now

password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
DUMMY_HASH = password_hasher.hash(secrets.token_urlsafe(30))
ROLE_RANK = {"developer": 0, "tester": 1, "manager": 2, "owner": 3}
SCOPES = [
    "projects:read",
    "projects:create",
    "projects:write",
    "projects:archive",
    "use_cases:write",
    "use_cases:publish",
    "specifications:write",
    "accounts:write",
    "secrets:read",
    "secrets:write",
    "environments:write",
    "members:write",
    "proposals:write",
    "proposals:review",
    "plans:write",
    "runs:write",
    "comments:write",
    "comments:moderate",
    "reports:write",
    "reports:share",
    "notifications:read",
    "notifications:write",
    "audit:read",
    "exports:read",
]


def fail(code: str, message: str, status: int = 400) -> NoReturn:
    """Abort with a stable, user-readable domain error; callers roll back the transaction."""
    raise HTTPException(status, detail={"code": code, "message": message})


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def content_hash(value: Any) -> str:
    return digest(canonical(value))


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def encrypt(value: str) -> bytes:
    """Encrypt a UTF-8 secret with a fresh nonce and the application encryption key."""
    nonce = secrets.token_bytes(12)
    return nonce + AESGCM(base64.urlsafe_b64decode(settings().encryption_key)).encrypt(
        nonce, value.encode(), b"ucaselab:v1"
    )


def decrypt(value: bytes) -> str:
    return (
        AESGCM(base64.urlsafe_b64decode(settings().encryption_key))
        .decrypt(value[:12], value[12:], b"ucaselab:v1")
        .decode()
    )


@dataclass
class Actor:
    user: User
    token: ApiToken | None = None
    session: Session | None = None

    def scope(self, scope: str) -> None:
        if self.token and scope not in self.token.scopes:
            fail("INSUFFICIENT_SCOPE", f"Токену требуется разрешение {scope}", 403)


def authenticate(db: DBSession, request: Request, bearer_only: bool = False) -> Actor:
    """Authenticate live credentials; browser mutations also require origin and CSRF checks."""
    authorization = request.headers.get("authorization", "")
    if authorization.startswith("Bearer "):
        raw = authorization[7:]
        token = db.scalar(select(ApiToken).where(ApiToken.token_hash == digest(raw)))
        if not token or token.revoked or aware(token.expires_at) <= now():
            fail("UNAUTHENTICATED", "Токен недействителен или истёк", 401)
        user = db.get(User, token.user_id)
        if not user or not user.verified:
            fail("UNAUTHENTICATED", "Подтвердите почту", 401)
        token.last_used_at = now()
        return Actor(user, token=token)
    if bearer_only:
        fail("UNAUTHENTICATED", "Требуется Bearer MCP-токен", 401)
    cookie = request.cookies.get("tc_session")
    session = db.scalar(select(Session).where(Session.token_hash == digest(cookie))) if cookie else None
    if not session or aware(session.expires_at) <= now():
        fail("UNAUTHENTICATED", "Войдите в аккаунт", 401)
    user = db.get(User, session.user_id)
    if not user or not user.verified:
        fail("UNAUTHENTICATED", "Войдите в аккаунт", 401)
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        check_origin(request)
        if not hmac.compare_digest(request.headers.get("x-csrf-token", ""), session.csrf):
            fail("CSRF", "Обновите страницу и повторите действие", 403)
    return Actor(user, session=session)


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    allowed = {settings().public_url.rstrip("/")}
    allowed.update(
        value.strip().rstrip("/") for value in settings().allowed_origins.split(",") if value.strip()
    )
    if origin and origin.rstrip("/") not in allowed:
        fail("INVALID_ORIGIN", "Источник запроса не разрешён", 403)


def membership(
    db: DBSession, actor: Actor, project_id: str, minimum: str = "developer", allow_archived: bool = False
) -> Membership:
    """Recheck membership, token allowlist, role and archive status on every request."""
    actor.scope("projects:read")
    if actor.token and project_id not in actor.token.project_ids:
        fail("NOT_FOUND", "Проект не найден", 404)
    member = db.scalar(
        select(Membership)
        .where(Membership.project_id == project_id, Membership.user_id == actor.user.id)
        .execution_options(populate_existing=True)
    )
    project = db.get(Project, project_id)
    if not member or not project:
        fail("NOT_FOUND", "Проект не найден", 404)
    if ROLE_RANK[member.role] < ROLE_RANK[minimum]:
        fail("FORBIDDEN", "Недостаточно прав для этого действия", 403)
    if project.archived and not allow_archived:
        fail("PROJECT_ARCHIVED", "Проект в архиве", 409)
    return member


def rate_limit(db, key, limit=10, seconds=900):
    safe_key = hmac.new(settings().secret_key.encode(), key.encode(), hashlib.sha256).hexdigest()
    # Serialize the first insertion as well as later updates in PostgreSQL.
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy import text

        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": int(safe_key[:15], 16)})
    bucket = db.get(RateBucket, safe_key, with_for_update=True)
    if not bucket:
        bucket = RateBucket(key=safe_key, count=0, resets_at=now() + timedelta(seconds=seconds))
        db.add(bucket)
    elif aware(bucket.resets_at) <= now():
        bucket.count = 0
        bucket.resets_at = now() + timedelta(seconds=seconds)
    bucket.count += 1
    exceeded = bucket.count > limit
    db.commit()  # Failed logins must still consume the quota.
    if exceeded:
        fail("RATE_LIMITED", "Слишком много попыток. Повторите позже", 429)
