"""Preflight observations belong to the run, never contain secrets or probe arbitrary URLs."""

from typing import Annotated
from urllib.parse import urlsplit

from pydantic import Field
from sqlalchemy import select

from . import models as m
from .operations import operation
from .schemas import ReadinessChecks
from .security import content_hash, fail


def assess_readiness(ctx, run):
    """Compare executor attestations with current account metadata, without revealing credentials."""
    linked = {}
    for accounts in ctx.db.scalars(select(m.RunItem.snapshot["accounts"]).where(m.RunItem.run_id == run.id)):
        for account in accounts:
            linked[account["id"]] = account
    accounts, issues = [], []
    current_accounts = {
        a.id: a
        for a in ctx.db.scalars(
            select(m.TestAccount).where(
                m.TestAccount.id.in_(linked), m.TestAccount.project_id == ctx.project_id
            )
        )
    }
    for account_id in sorted(linked):
        pinned = linked[account_id]
        account = current_accounts.get(account_id)
        valid = account is not None and account.project_id == ctx.project_id and not account.archived
        mismatch = (
            account is not None
            and valid
            and account.environment_id
            and account.environment_id != run.environment.get("id")
        )
        changed = valid and any(
            getattr(account, field) != pinned.get(field) for field in ("login", "environment_id")
        )
        entry = {
            "id": account_id,
            "name": pinned["name"],
            "login": pinned.get("login", ""),
            "version": account.version if account else None,
            "available": bool(valid and not mismatch and not changed),
            "has_secret": bool(account and account.encrypted_secret),
        }
        accounts.append(entry)
        if not entry["available"]:
            issues.append(
                {
                    "code": "ACCOUNT_CHANGED",
                    "message": f"{pinned['name']}: аккаунт архивирован, перемещён или изменился после подготовки. Подготовьте новый прогон.",
                    "blocking": True,
                }
            )
        elif not entry["login"] or not entry["has_secret"]:
            issues.append(
                {
                    "code": "ACCOUNT_DETAILS",
                    "message": f"{pinned['name']}: проверьте способ входа — логин или секрет не сохранён.",
                    "blocking": False,
                }
            )
    if not accounts:
        issues.append(
            {
                "code": "NO_LINKED_ACCOUNTS",
                "message": "Тестовые аккаунты не связаны с кейсами. Укажите, нужны ли они для выбранных проверок.",
                "blocking": False,
            }
        )
    if not run.environment.get("base_url"):
        issues.append(
            {
                "code": "NO_TARGET_URL",
                "message": "Адрес приложения не указан. Добавьте адрес или опишите другой способ доступа в пояснении.",
                "blocking": False,
            }
        )
    readiness = run.readiness or {}
    checks = ReadinessChecks.model_validate(readiness.get("checks", {})).model_dump()
    fingerprint = content_hash({"environment": run.environment, "build": run.build, "accounts": accounts})
    confirmed = bool(readiness.get("checked_at")) and readiness.get("fingerprint") == fingerprint
    complete = all(value in {"ready", "not_required"} for value in checks.values())
    if accounts and checks["accounts"] == "not_required":
        complete = False
        issues.append(
            {
                "code": "ACCOUNTS_REQUIRED",
                "message": "В сценариях есть связанные аккаунты: подтвердите их готовность или запуск с ограничениями.",
                "blocking": True,
            }
        )
    ready = confirmed and complete and not any(issue["blocking"] for issue in issues)
    partial = confirmed and bool(readiness.get("allow_partial") and readiness.get("notes"))
    legacy = not readiness
    return {
        "checks": checks,
        "accounts": accounts,
        "issues": issues,
        "fingerprint": fingerprint,
        "confirmed": confirmed,
        "ready": ready,
        "can_start": legacy or ready or partial,
        "legacy": legacy,
        "assessment": readiness,
        "environment": run.environment,
        "build": run.build,
        "run_version": run.version,
        "message": "Готовность подтверждена"
        if ready
        else "Запуск с ограничениями"
        if partial
        else "Подтвердите готовность перед началом",
    }


def require_readiness(ctx, run):
    """Enforce preflight for new runs, including low-level start operations."""
    if not assess_readiness(ctx, run)["can_start"]:
        fail(
            "RUN_NOT_READY",
            "Перед запуском вызовите get_run_readiness и confirm_run_readiness. Проверьте стенд, аккаунты и внешние зависимости своими инструментами.",
            409,
        )


@operation("runs:write", "tester")
def get_run_readiness(ctx, run_id: str):
    """Проверить подготовку прогона: адрес и сборка, связанные аккаунты без секретов, подтверждения исполнителя и причины ограничений. Сетевую доступность, почту и CAPTCHA проверяет сам исполнитель; сервер не обращается к URL стенда."""
    return assess_readiness(ctx, ctx.get(m.Run, run_id))


@operation("runs:write", "tester", write=True)
def confirm_run_readiness(
    ctx,
    run_id: str,
    expected_version: int,
    checks: ReadinessChecks,
    notes: Annotated[str, Field(max_length=10000)] = "",
    actual_base_url: Annotated[str, Field(max_length=2000)] | None = None,
    allow_partial: bool = False,
):
    """До запуска сохранить фактическую готовность стенда, аккаунтов и зависимостей с expected_version. actual_base_url исправляет только снимок этого прогона. Для запуска с ограничениями нужны allow_partial=true и причина; это не превращает непроверенные условия в ready. Секреты не передавайте."""
    run = ctx.get(m.Run, run_id)
    ctx.expect(run, expected_version)
    if run.status != "draft":
        fail("INVALID_RUN_STATE", "Подготовку можно менять только до начала прогона", 409)
    if allow_partial and not notes.strip():
        fail("READINESS_REASON_REQUIRED", "Объясните ограничения и какую часть можно проверить")
    if actual_base_url is not None:
        try:
            url = urlsplit(actual_base_url.strip())
            url.port
        except ValueError:
            fail("INVALID_URL", "Проверьте адрес приложения и порт")
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.fragment
        ):
            fail("INVALID_URL", "Укажите http(s)-адрес приложения без пароля, токена или фрагмента")
        if url.query:
            fail("INVALID_URL", "Адрес стенда должен быть без параметров запроса")
        run.environment = {**run.environment, "base_url": actual_base_url.strip().rstrip("/")}
    current = assess_readiness(ctx, run)
    run.readiness = {
        "required": True,
        "checks": checks.model_dump(),
        "notes": notes.strip(),
        "allow_partial": allow_partial,
        "checked_at": m.now().isoformat(),
        "checked_by": ctx.user_id,
        "fingerprint": current["fingerprint"],
    }
    run.version += 1
    ctx.audit("run.readiness_confirmed", run.id, {"allow_partial": allow_partial})
    return assess_readiness(ctx, run)
