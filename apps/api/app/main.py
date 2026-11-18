import hashlib
import json
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import (  # Register domain operations first.  # noqa: F401
    activity,
    cases,
    collaboration,
    core,
    folders,
    proposals,
    reports,
    runs,
)
from . import models as m
from .agent_bootstrap import find_skill, load_skill_catalog
from .agent_bootstrap import router as agent_router
from .auth import router as auth_router
from .config import settings
from .db import SessionLocal, get_db
from .operations import REGISTRY, Context, dispatch, operation
from .security import SCOPES, authenticate, aware, digest, fail, membership
from .version import VERSION

ROOT = Path(__file__).resolve().parents[3]
log = logging.getLogger("ucaselab")


@operation(global_=True)
def list_skills(ctx):
    """Прочитать каталог навыков текущего релиза с версиями, адресами загрузки и SHA-256."""
    base = settings().public_url.rstrip("/")
    return {
        **load_skill_catalog(),
        "bootstrap_url": base + "/ai.md",
        "manifest_url": base + "/api/agent/manifest",
    }


@operation(global_=True)
def get_skill(ctx, name: str):
    """Прочитать Markdown выбранного навыка и ссылки на его архив. Установка и выполнение выполняются клиентом в рамках поручения."""
    skill = find_skill(name)
    return {
        **skill,
        "content": (ROOT / "skills" / name / "SKILL.md").read_text(),
        "download_path": "/api/skills/" + skill["archive"],
    }


from mcp.server.transport_security import TransportSecuritySettings

from . import evidence, run_readiness, run_workflow  # noqa: F401
from .mcp_server import server as mcp_server

mcp_app = mcp_server.streamable_http_app(
    streamable_http_path="/",
    json_response=True,
    stateless_http=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
# TrustedHostMiddleware and exact Origin policy below provide rebinding protection for both APIs.


@asynccontextmanager
async def lifespan(app):
    settings().validate_runtime()
    Path(settings().storage_path).mkdir(parents=True, exist_ok=True)
    async with mcp_server.session_manager.run():
        yield


app = FastAPI(title="UCaseLab API", version=VERSION, lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings().allowed_hosts.split(","))
app.include_router(auth_router)
app.include_router(agent_router)


@app.middleware("http")
async def boundaries(request, call_next):
    if request.url.path.startswith("/mcp"):
        from .security import check_origin

        try:
            check_origin(request)
            await run_in_threadpool(authenticate_mcp_request, request)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {
                "code": "UNAUTHENTICATED" if exc.status_code == 401 else "FORBIDDEN",
                "message": str(exc.detail),
            }
            return JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32001 if exc.status_code == 401 else -32003,
                        "message": detail["code"],
                        "data": {**detail, "status": exc.status_code},
                    },
                },
                status_code=exc.status_code,
                headers={"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"},
            )
    maximum = (
        (settings().max_upload_mb + 1) * 1024 * 1024
        if "/attachments/upload" in request.url.path
        else 4 * 1024 * 1024
    )
    try:
        if int(request.headers.get("content-length", "0")) > maximum:
            return JSONResponse(
                {"detail": {"code": "BODY_TOO_LARGE", "message": "Запрос слишком большой"}}, 413
            )
    except ValueError:
        return JSONResponse(
            {"detail": {"code": "INVALID_LENGTH", "message": "Некорректная длина запроса"}}, 400
        )
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Frame-Options"] = "DENY"
    return response


def authenticate_mcp_request(request: Request) -> None:
    """Keep synchronous DB locks off the event loop, including token last-used updates."""
    with SessionLocal() as db:
        authenticate(db, request, bearer_only=True)
        db.commit()


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    # FastAPI's default error includes input (including passwords); return only safe messages.
    return JSONResponse(
        {
            "detail": {
                "code": "VALIDATION_ERROR",
                "message": "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()),
            }
        },
        422,
    )


@app.exception_handler(IntegrityError)
async def integrity_error(request, exc):
    log.warning("Integrity conflict: %s", request.url.path)
    return JSONResponse(
        {
            "detail": {
                "code": "CONFLICT",
                "message": "Данные изменились или нарушают связь. Обновите страницу",
            }
        },
        409,
    )


@app.get("/api/health/live")
def live():
    return {"status": "ok"}


@app.get("/api/health/ready")
def ready(db=Depends(get_db)):
    db.execute(text("SELECT id FROM users LIMIT 1"))
    return {"status": "ready", "version": VERSION}


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str | None = None
    arguments: dict = Field(default_factory=dict)
    idempotency_key: str | None = None


@app.post("/api/actions/{name}")
def action(name: str, data: Command, request: Request, db=Depends(get_db)):
    actor = authenticate(db, request)
    if actor.token and name == "reveal_test_account_secret" and data.idempotency_key:
        fail("SECRET_NOT_CACHEABLE", "Операция раскрытия не поддерживает idempotency cache")
    result = dispatch(
        db,
        actor,
        name,
        data.project_id,
        data.arguments,
        data.idempotency_key if name != "reveal_test_account_secret" else None,
    )
    db.commit()
    return result


@app.get("/api/operations")
def operations(request: Request, db=Depends(get_db)):
    authenticate(db, request)
    return {
        name: {
            "description": op["func"].__doc__,
            "schema": op["model"].model_json_schema(),
            "scope": op["scope"],
            "role": op["role"],
            "global": op["global_"],
            "write": op["write"],
        }
        for name, op in REGISTRY.items()
    }


def profile_actor(db, request):
    actor = authenticate(db, request)
    if actor.token:
        fail("BROWSER_REQUIRED", "Управление токенами доступно в профиле браузера", 403)
    return actor


class TokenAccess(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_access: Literal["selected", "all"] = "selected"
    project_ids: list[StrictStr] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def valid_access(self):
        if len(set(self.project_ids)) != len(self.project_ids):
            raise ValueError("Проекты не должны повторяться")
        if self.project_access == "all" and self.project_ids:
            raise ValueError("Для всех проектов список должен быть пустым")
        if any(not value or len(value) > 36 for value in self.project_ids):
            raise ValueError("Некорректный идентификатор проекта")
        return self


class TokenCreate(TokenAccess):
    name: StrictStr = Field(min_length=1, max_length=100)
    scopes: list[StrictStr] = Field(min_length=1, max_length=40)
    expires_days: StrictInt = Field(default=90, ge=1, le=365)



class TokenAccessUpdate(TokenAccess):
    project_access: Literal["selected", "all"]
    project_ids: list[StrictStr] = Field(max_length=200)
    expected_version: StrictInt = Field(ge=1)


def token_fields(token):
    return core.fields(token, "name", "prefix", "scopes", "project_ids", "project_access",
                       "access_version", "expires_at", "revoked", "last_used_at")


@app.get("/api/tokens")
def list_tokens(request: Request, db=Depends(get_db)):
    actor = profile_actor(db, request)
    return {
        "items": [
            token_fields(t)
            for t in db.scalars(
                select(m.ApiToken)
                .where(m.ApiToken.user_id == actor.user.id)
                .order_by(m.ApiToken.created_at.desc())
            )
        ]
    }


@app.post("/api/tokens")
def create_token(data: TokenCreate, request: Request, db=Depends(get_db)):
    actor = profile_actor(db, request)
    if not set(data.scopes) <= set(SCOPES):
        fail("INVALID_SCOPE", "Неизвестное разрешение")
    for project_id in data.project_ids:
        membership(db, actor, project_id)
    raw = "tc_" + secrets.token_urlsafe(40)
    token = m.ApiToken(
        user_id=actor.user.id,
        name=data.name,
        prefix=raw[:12],
        token_hash=digest(raw),
        scopes=list(dict.fromkeys(data.scopes)),
        project_ids=data.project_ids,
        project_access=data.project_access,
        expires_at=m.now() + timedelta(days=data.expires_days),
    )
    db.add(token)
    db.commit()
    return {"id": token.id, "token": raw, "expires_at": token.expires_at}


@app.patch("/api/tokens/{token_id}")
def update_token_access(token_id: str, data: TokenAccessUpdate, request: Request, db=Depends(get_db)):
    """Изменить проекты прежнего токена без продления срока и раскрытия секрета."""
    actor = profile_actor(db, request)
    token = db.scalar(select(m.ApiToken).where(
        m.ApiToken.id == token_id, m.ApiToken.user_id == actor.user.id
    ).with_for_update().execution_options(populate_existing=True))
    if not token:
        fail("NOT_FOUND", "Токен не найден", 404)
    if token.revoked or aware(token.expires_at) <= m.now():
        fail("TOKEN_INACTIVE", "Истёкший или отозванный токен нельзя изменить", 409)
    if token.access_version != data.expected_version:
        fail("VERSION_CONFLICT", "Доступ уже изменён. Откройте актуальные настройки и сравните выбор", 409)
    for project_id in data.project_ids:
        # Retaining an old inaccessible selection grants nothing; users can remove it.
        # Newly added IDs must be currently accessible and unarchived.
        if project_id not in token.project_ids:
            membership(db, actor, project_id)
    token.project_access = data.project_access
    token.project_ids = data.project_ids
    token.access_version += 1
    db.commit()
    return token_fields(token)


@app.delete("/api/tokens/{token_id}")
def revoke_token(token_id: str, request: Request, db=Depends(get_db)):
    actor = profile_actor(db, request)
    token = db.get(m.ApiToken, token_id)
    if not token or token.user_id != actor.user.id:
        fail("NOT_FOUND", "Токен не найден", 404)
    token.revoked = True
    db.commit()
    return {"ok": True}


@app.get("/api/skills/{archive}")
def download_skill(archive: str, request: Request, db=Depends(get_db)):
    authenticate(db, request)
    index = json.loads((ROOT / "dist/skills/index.json").read_text())
    if archive not in {s["archive"] for s in index["skills"]}:
        fail("NOT_FOUND", "Архив не найден", 404)
    return FileResponse(ROOT / "dist/skills" / archive, filename=archive, media_type="application/zip")


@app.post("/api/projects/{project_id}/attachments/upload")
def upload_attachment(
    project_id: str, execution_id: str, file: UploadFile, request: Request, db=Depends(get_db)
):
    actor = authenticate(db, request)
    member = membership(db, actor, project_id, "tester")
    actor.scope("runs:write")
    ctx = Context(db, actor, db.get(m.Project, project_id), member)
    ctx.project = db.scalar(
        select(m.Project)
        .where(m.Project.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    ctx.member = membership(db, actor, project_id, "tester")
    execution, item, run = runs.execution_context(ctx, execution_id)
    if execution.status != "running" or execution.actor_id != actor.user.id or run.status != "running":
        fail(
            "EXECUTION_IMMUTABLE",
            "Вложения добавляются исполнителем во время выполнения. Для закрытой проверки используйте пояснение",
            409,
        )
    data = file.file.read(settings().max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings().max_upload_mb * 1024 * 1024:
        fail("FILE_TOO_LARGE", "Файл превышает допустимый размер", 413)
    filename = Path(file.filename or "evidence").name[:240]
    storage_key = secrets.token_hex(32)
    path = Path(settings().storage_path) / storage_key
    path.write_bytes(data)
    obj = m.Attachment(
        project_id=project_id,
        execution_id=execution_id,
        author_id=actor.user.id,
        filename=filename,
        content_type=(file.content_type or "application/octet-stream")[:120],
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        storage_key=storage_key,
    )
    db.add(obj)
    try:
        db.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return core.fields(obj, "filename", "size", "sha256")


@app.get("/api/projects/{project_id}/attachments/{attachment_id}")
def download_attachment(project_id: str, attachment_id: str, request: Request, db=Depends(get_db)):
    actor = authenticate(db, request)
    dispatch(db, actor, "get_attachment_download", project_id, {"attachment_id": attachment_id})
    attachment = db.get(m.Attachment, attachment_id)
    if not attachment or attachment.project_id != project_id:
        fail("NOT_FOUND", "Вложение не найдено", 404)
    path = Path(settings().storage_path) / attachment.storage_key
    if not path.is_file():
        fail("EVIDENCE_MISSING", "Файл недоступен в хранилище. Обратитесь к администратору сервера", 404)
    return FileResponse(
        path,
        filename=attachment.filename,
        media_type="application/octet-stream",
    )


@app.get("/api/projects/{project_id}/reports/{report_id}/download")
def download_report(
    project_id: str,
    report_id: str,
    request: Request,
    format: Literal["json", "csv", "pdf"] = "pdf",
    db=Depends(get_db),
):
    actor = authenticate(db, request)
    report = dispatch(db, actor, "get_report", project_id, {"report_id": report_id})
    from .report_files import render_report

    data, content_type = render_report(report, format)
    return Response(
        data,
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="report-{report_id}.{format}"'},
    )


@app.get("/api/projects/{project_id}/ai.md")
def guide(project_id: str, request: Request, db=Depends(get_db)):
    actor = authenticate(db, request)
    result = dispatch(db, actor, "get_project_guide", project_id)
    return Response(
        result["content"],
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="ai.md"'},
    )


app.mount("/mcp", mcp_app)
