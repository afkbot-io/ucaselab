import base64
import secrets
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import delete, select

from .config import settings
from .db import get_db
from .models import AuthChallenge, Invitation, Membership, Outbox, Session, User, now
from .security import (
    DUMMY_HASH,
    SCOPES,
    authenticate,
    aware,
    check_origin,
    digest,
    encrypt,
    fail,
    password_hasher,
    rate_limit,
)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("email", "name", mode="before", check_fields=False)
    @classmethod
    def trim_metadata(cls, value):
        return value.strip() if isinstance(value, str) else value


class Register(Input):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=10, max_length=128)


class Login(Input):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class EmailInput(Input):
    email: EmailStr
    kind: Literal["verify", "reset", "login"] = "verify"


class TokenInput(Input):
    token: str = Field(min_length=20, max_length=200)
    password: str | None = Field(default=None, min_length=10, max_length=128)


def send_challenge(db, user, kind):
    if not settings().email_enabled:
        fail("EMAIL_DISABLED", "Вход по ссылке и восстановление через почту отключены на этом сервере.", 409)
    raw = secrets.token_urlsafe(32)
    db.add(
        AuthChallenge(
            user_id=user.id, kind=kind, token_hash=digest(raw), expires_at=now() + timedelta(minutes=30)
        )
    )
    title = {"verify": "Подтвердите почту", "reset": "Сброс пароля", "login": "Вход в UCaseLab"}[kind]
    link = f"{settings().public_url}/auth/{kind}?token={raw}"
    mail = {
        "to": user.email,
        "subject": f"{title} — UCaseLab",
        "body": f"{user.name},\n\n{title}:\n{link}\n\nСсылка действует 30 минут. Если вы не запрашивали письмо, проигнорируйте его.",
    }
    import json

    db.add(
        Outbox(
            kind="email",
            payload={
                "encrypted": base64.urlsafe_b64encode(encrypt(json.dumps(mail, ensure_ascii=False))).decode()
            },
        )
    )


def create_session(db, user, response):
    raw = secrets.token_urlsafe(40)
    session = Session(
        user_id=user.id,
        token_hash=digest(raw),
        csrf=secrets.token_urlsafe(32),
        expires_at=now() + timedelta(days=settings().session_days),
    )
    db.add(session)
    response.set_cookie(
        "tc_session",
        raw,
        httponly=True,
        secure=settings().cookie_secure,
        samesite="lax",
        max_age=settings().session_days * 86400,
        path="/",
    )
    return {"user": {"id": user.id, "email": user.email, "name": user.name}, "csrf": session.csrf}


@router.get("/config")
def auth_config():
    return {"email_enabled": settings().email_enabled}


@router.post("/register", status_code=202)
def register(data: Register, request: Request, db=Depends(get_db)):
    check_origin(request)
    email = str(data.email).casefold()
    rate_limit(db, f"register:{(request.client.host if request.client else 'unknown')}", 10, 3600)
    user = db.scalar(select(User).where(User.email == email))
    if not user:
        user = User(
            email=email,
            name=data.name,
            password_hash=password_hasher.hash(data.password),
            verified=not settings().email_enabled,
        )
        db.add(user)
        db.flush()
        if settings().email_enabled:
            send_challenge(db, user, "verify")
    # Do not replace a pending account's password via a second registration.
    db.commit()
    return {
        "requires_verification": settings().email_enabled,
        "message": "Если адрес доступен для регистрации, на него отправлена ссылка подтверждения. Проверьте почту."
        if settings().email_enabled
        else "Если адрес свободен, аккаунт создан. Теперь войдите с указанными почтой и паролем.",
    }


@router.post("/login")
def login(data: Login, request: Request, response: Response, db=Depends(get_db)):
    check_origin(request)
    email = str(data.email).casefold()
    rate_limit(db, f"login-ip:{(request.client.host if request.client else 'unknown')}", 40)
    rate_limit(db, f"login:{email}", 10)
    user = db.scalar(select(User).where(User.email == email))
    from argon2.exceptions import VerificationError

    try:
        password_hasher.verify(user.password_hash if user else DUMMY_HASH, data.password)
    except VerificationError:
        fail("INVALID_CREDENTIALS", "Неверная почта или пароль", 401)
    if not user:
        fail("INVALID_CREDENTIALS", "Неверная почта или пароль", 401)
    if not user.verified:
        fail("EMAIL_NOT_VERIFIED", "Подтвердите почту. Можно запросить новое письмо", 403)
    if password_hasher.check_needs_rehash(user.password_hash):
        user.password_hash = password_hasher.hash(data.password)
    result = create_session(db, user, response)
    db.commit()
    return result


@router.post("/email", status_code=202)
def email_link(data: EmailInput, request: Request, db=Depends(get_db)):
    check_origin(request)
    if not settings().email_enabled:
        fail("EMAIL_DISABLED", "Отправка писем отключена на этом сервере. Войдите по паролю.", 409)
    email = str(data.email).casefold()
    rate_limit(db, f"email-ip:{(request.client.host if request.client else 'unknown')}", 20, 3600)
    rate_limit(db, f"email:{email}", 5, 3600)
    user = db.scalar(select(User).where(User.email == email))
    if user and ((data.kind == "verify" and not user.verified) or (data.kind != "verify" and user.verified)):
        send_challenge(db, user, data.kind)
    db.commit()
    return {"message": "Если аккаунт существует, письмо отправлено. Проверьте входящие и спам."}


@router.post("/consume")
def consume(data: TokenInput, request: Request, response: Response, db=Depends(get_db)):
    check_origin(request)
    rate_limit(db, f"consume:{(request.client.host if request.client else 'unknown')}", 40)
    challenge = db.scalar(
        select(AuthChallenge).where(AuthChallenge.token_hash == digest(data.token)).with_for_update()
    )
    if not challenge or challenge.used or aware(challenge.expires_at) <= now():
        fail("INVALID_LINK", "Ссылка недействительна или истекла. Запросите новую", 400)
    user = db.get(User, challenge.user_id)
    if challenge.kind == "reset":
        if not data.password:
            fail("PASSWORD_REQUIRED", "Введите новый пароль")
        user.password_hash = password_hasher.hash(data.password)
        db.execute(delete(Session).where(Session.user_id == user.id))
        from .models import ApiToken

        for token in db.scalars(select(ApiToken).where(ApiToken.user_id == user.id)):
            token.revoked = True
    elif challenge.kind == "verify":
        user.verified = True
    elif not user.verified:
        fail("EMAIL_NOT_VERIFIED", "Подтвердите почту", 403)
    challenge.used = True
    # A password reset revokes every previously issued login/reset link as well.
    siblings = select(AuthChallenge).where(AuthChallenge.user_id == user.id)
    if challenge.kind != "reset":
        siblings = siblings.where(AuthChallenge.kind == challenge.kind)
    for other in db.scalars(siblings):
        other.used = True
    result = create_session(db, user, response)
    db.commit()
    return result


@router.get("/me")
def me(request: Request, db=Depends(get_db)):
    actor = authenticate(db, request)
    return {
        "user": {
            "id": actor.user.id,
            "email": actor.user.email,
            "name": actor.user.name,
            "preferences": {"theme": actor.user.preferences.get("theme", "system")},
        },
        "csrf": actor.session.csrf if actor.session else None,
        "available_scopes": SCOPES,
    }


@router.post("/logout")
def logout(request: Request, response: Response, db=Depends(get_db)):
    actor = authenticate(db, request)
    if actor.session:
        db.delete(actor.session)
    db.commit()
    response.delete_cookie("tc_session", path="/")
    return {"ok": True}


class ProfileInput(Input):
    """Editable identity and appearance; omitted fields retain their current values."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    theme: Literal["system", "light", "dark"] | None = None


@router.patch("/profile")
def profile(data: ProfileInput, request: Request, db=Depends(get_db)):
    actor = authenticate(db, request)
    if actor.token:
        fail("BROWSER_REQUIRED", "Откройте профиль в браузере", 403)
    db.refresh(actor.user, with_for_update=True)
    if data.name is not None:
        actor.user.name = data.name
    if data.theme is not None:
        actor.user.preferences = {**actor.user.preferences, "theme": data.theme}
    db.commit()
    return {"ok": True}


class AcceptInvitation(Input):
    token: str = Field(min_length=20, max_length=200)


@router.post("/accept-invitation")
def accept_invitation(data: AcceptInvitation, request: Request, db=Depends(get_db)):
    actor = authenticate(db, request)
    if actor.token:
        fail("BROWSER_REQUIRED", "Откройте приглашение в браузере", 403)
    invitation = db.scalar(
        select(Invitation).where(Invitation.token_hash == digest(data.token)).with_for_update()
    )
    if not invitation or invitation.accepted or invitation.revoked or aware(invitation.expires_at) <= now():
        fail("INVALID_INVITATION", "Приглашение недействительно", 400)
    if invitation.email != actor.user.email:
        fail("EMAIL_MISMATCH", "Войдите с почтой, на которую отправлено приглашение", 403)
    member = db.scalar(
        select(Membership).where(
            Membership.project_id == invitation.project_id, Membership.user_id == actor.user.id
        )
    )
    if not member:
        db.add(Membership(project_id=invitation.project_id, user_id=actor.user.id, role=invitation.role))
    invitation.accepted = True
    db.commit()
    return {"project_id": invitation.project_id}
