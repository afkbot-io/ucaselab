"""Guided execution workflow shared by the UI and MCP. Existing low-level tools remain valid."""

from typing import Annotated, Any, Literal

from pydantic import Field
from sqlalchemy import and_, func, or_, select

from . import models as m
from . import runs
from .catalog import Limit, Offset, Search, text_filter
from .operations import fields, operation
from .schemas import Outcome, Schema
from .security import fail


class StepOutcome(Schema):
    step_key: str = Field(min_length=1, max_length=80)
    status: Outcome
    actual_result: str = Field(default="", max_length=10000)


def check_index(run_id):
    latest = (
        select(m.Execution.run_item_id, func.max(m.Execution.attempt).label("attempt"))
        .join(m.RunItem)
        .where(m.RunItem.run_id == run_id)
        .group_by(m.Execution.run_item_id)
        .subquery()
    )
    return (
        select(
            m.RunItem.id.label("id"),
            m.RunItem.position,
            m.RunItem.use_case_id,
            m.RunItem.assignee_id,
            m.RunItem.snapshot["key"].as_string().label("key"),
            m.RunItem.snapshot["content"]["title"].as_string().label("title"),
            m.RunItem.snapshot["variant"]["name"].as_string().label("variant_name"),
            m.RunItem.snapshot["variant"]["polarity"].as_string().label("polarity"),
            m.RunItem.snapshot["publication_number"].as_integer().label("publication_number"),
            m.RunItem.snapshot["revision_number"].as_integer().label("revision_number"),
            m.RunItem.snapshot["case_source"].as_string().label("case_source"),
            m.Execution.id.label("execution_id"),
            m.Execution.status,
            m.Execution.attempt,
            m.Execution.actor_id,
            m.Execution.source,
            m.Execution.started_at,
            m.Execution.finished_at,
            m.User.name.label("actor_name"),
        )
        .join(latest, latest.c.run_item_id == m.RunItem.id)
        .join(
            m.Execution,
            and_(m.Execution.run_item_id == latest.c.run_item_id, m.Execution.attempt == latest.c.attempt),
        )
        .outerjoin(m.User, m.User.id == m.Execution.actor_id)
        .where(m.RunItem.run_id == run_id)
    )


def next_action(ctx, run, summary, prepared=True):
    if not ctx.qa:
        return {
            "kind": "view_results",
            "message": "Наблюдайте за выполнением и сохранёнными результатами команды.",
        }
    active = (
        ctx.db.execute(
            check_index(run.id)
            .where(m.Execution.status == "running", m.Execution.actor_id == ctx.user_id)
            .order_by(m.RunItem.position)
            .limit(1)
        )
        .mappings()
        .first()
    )
    if run.status in {"completed", "cancelled"}:
        return {"kind": "view_results", "message": "Прогон закрыт. Посмотрите результаты или создайте отчёт."}
    if active:
        return {
            "kind": "resume_check",
            "check_id": active["id"],
            "tool": "get_run_check",
            "arguments": {"project_id": ctx.project_id, "run_item_id": active["id"]},
            "message": "Продолжите свою текущую проверку.",
        }
    if run.status == "draft" and not prepared:
        return {
            "kind": "prepare_run",
            "tool": "get_run_readiness",
            "arguments": {"project_id": ctx.project_id, "run_id": run.id},
            "message": "Проверьте готовность стенда, аккаунтов и зависимостей перед началом.",
        }
    if not summary["counts"]["queued"] and not summary["counts"]["running"]:
        return {
            "kind": "complete_run",
            "tool": "complete_run",
            "arguments": {"project_id": ctx.project_id, "run_id": run.id, "expected_version": run.version},
            "message": "Все результаты записаны. Можно завершить прогон.",
        }
    pending = ctx.db.execute(
        check_index(run.id)
        .add_columns(m.RunItem.snapshot["accounts"].label("accounts"))
        .where(
            m.Execution.status == "queued",
            or_(m.RunItem.assignee_id.is_(None), m.RunItem.assignee_id == ctx.user_id),
        )
        .order_by(m.RunItem.position)
    ).mappings()
    busy = busy_accounts(ctx)
    candidate = next(
        (row for row in pending if not busy.intersection(a["id"] for a in (row["accounts"] or []))), None
    )
    if candidate and ctx.qa:
        return {
            "kind": "begin_check",
            "check_id": candidate["id"],
            "tool": "begin_run_check",
            "arguments": {"project_id": ctx.project_id, "run_id": run.id},
            "message": "Начните следующую доступную проверку.",
        }
    return {
        "kind": "wait",
        "message": "Оставшиеся проверки заняты, назначены другим участникам или ожидают освобождения тестового аккаунта.",
    }


@operation()
def get_run_overview(ctx, run_id: str):
    """Короткое состояние прогона без снимков всех кейсов: прогресс, текущие исполнители, доступные действия и точный следующий MCP-вызов. Завершённые результаты включают failed/blocked/skipped: завершение не равно успеху."""
    run = ctx.get(m.Run, run_id)
    summary = runs.run_summary(ctx, run)
    from .run_readiness import assess_readiness

    prepared = run.status != "draft" or assess_readiness(ctx, run)["can_start"]
    remaining = summary["counts"]["queued"] + summary["counts"]["running"]
    finished = summary["selected"] - remaining
    active = [
        dict(r)
        for r in ctx.db.execute(
            check_index(run.id).where(m.Execution.status == "running").order_by(m.RunItem.position)
        ).mappings()
    ]
    return {
        **fields(
            run,
            "title",
            "status",
            "version",
            "build",
            "environment",
            "source",
            "author_id",
            "finished_at",
            "case_source",
            "readiness",
        ),
        "summary": summary,
        "progress": {
            "total": summary["selected"],
            "finished": finished,
            "remaining": remaining,
            "percent": round(100 * finished / summary["selected"]) if summary["selected"] else 0,
        },
        "active_checks": active,
        "actions": {
            "can_begin": ctx.qa and run.status in {"draft", "running"} and prepared,
            "can_complete": ctx.qa and run.status == "running" and remaining == 0,
            "can_cancel": ctx.qa and run.status in {"draft", "running"},
            "can_create_report": ctx.qa,
        },
        "next_action": next_action(ctx, run, summary, prepared),
    }


@operation()
def list_run_checks(
    ctx,
    run_id: str,
    search: Search = "",
    status: Literal[
        "all",
        "pending",
        "running",
        "passed",
        "failed",
        "scenario_issue",
        "blocked",
        "skipped",
        "cancelled",
        "attention",
    ] = "all",
    assignment: Literal["all", "mine", "unassigned"] = "all",
    limit: Limit = 50,
    offset: Offset = 0,
):
    """Постраничная очередь вариантов без полных снимков. pending=ещё не начаты, attention=failed/blocked. mine учитывает назначение и текущего исполнителя."""
    ctx.get(m.Run, run_id)
    query = check_index(run_id)
    query = text_filter(
        query,
        search,
        m.RunItem.snapshot["key"].as_string(),
        m.RunItem.snapshot["content"]["title"].as_string(),
        m.RunItem.snapshot["variant"]["name"].as_string(),
    )
    if status == "pending":
        query = query.where(m.Execution.status == "queued")
    elif status == "attention":
        query = query.where(m.Execution.status.in_(["failed", "scenario_issue", "blocked"]))
    elif status != "all":
        query = query.where(m.Execution.status == status)
    if assignment == "mine":
        query = query.where(or_(m.RunItem.assignee_id == ctx.user_id, m.Execution.actor_id == ctx.user_id))
    elif assignment == "unassigned":
        query = query.where(m.RunItem.assignee_id.is_(None))
    total = ctx.db.scalar(select(func.count()).select_from(query.subquery()))
    items = [
        dict(r)
        for r in ctx.db.execute(
            query.order_by(m.RunItem.position, m.RunItem.id).limit(limit).offset(offset)
        ).mappings()
    ]
    return {"items": items, "total": total, "next_offset": offset + limit if offset + limit < total else None}


@operation()
def get_run_check(ctx, run_item_id: str):
    """Одна закреплённая проверка: вариант и данные, шаги, попытки, наблюдения, файлы и разрешённые действия. Не загружает остальные снимки прогона."""
    item = ctx.db.get(m.RunItem, run_item_id)
    if not item:
        fail("NOT_FOUND", "Проверка не найдена", 404)
    run = ctx.get(m.Run, item.run_id)
    executions = runs.attempts(ctx, item.id)
    ids = [e.id for e in executions]
    attachments: dict[str, list[dict[str, Any]]] = {}
    annotations: dict[str, list[dict[str, Any]]] = {}
    for a in ctx.db.scalars(select(m.Attachment).where(m.Attachment.execution_id.in_(ids))):
        attachments.setdefault(a.execution_id, []).append(fields(a, "filename", "size", "sha256"))
    for a in ctx.db.scalars(
        select(m.ExecutionAnnotation)
        .where(m.ExecutionAnnotation.execution_id.in_(ids))
        .order_by(m.ExecutionAnnotation.created_at)
    ):
        annotations.setdefault(a.execution_id, []).append(fields(a, "body", "author_id"))
    names = dict(
        ctx.db.execute(
            select(m.User.id, m.User.name).where(
                m.User.id.in_([e.actor_id for e in executions] + [item.assignee_id])
            )
        ).all()
    )
    values = [
        {
            **fields(
                e,
                "status",
                "attempt",
                "source",
                "actor_id",
                "actual_result",
                "steps",
                "started_at",
                "finished_at",
                "external_issue_url",
            ),
            "actor_name": names.get(e.actor_id),
            "attachments": attachments.get(e.id, []),
            "annotations": annotations.get(e.id, []),
        }
        for e in executions
    ]
    latest = executions[-1]
    own_other = ctx.db.execute(
        check_index(run.id)
        .where(m.Execution.status == "running", m.Execution.actor_id == ctx.user_id, m.RunItem.id != item.id)
        .limit(1)
    ).first()
    assigned = not item.assignee_id or item.assignee_id == ctx.user_id
    return {
        **fields(
            item,
            "position",
            "run_id",
            "use_case_id",
            "snapshot",
            "assignee_id",
            "publication_id",
            "revision_id",
            "variant_key",
        ),
        "assignee_name": names.get(item.assignee_id),
        "attempts": values,
        "actions": {
            "can_begin": ctx.qa
            and assigned
            and not own_other
            and run.status in {"draft", "running"}
            and (latest.status == "queued" or latest.status == "running" and latest.actor_id == ctx.user_id),
            "can_record": ctx.qa
            and run.status == "running"
            and latest.status == "running"
            and latest.actor_id == ctx.user_id,
            "can_retry": ctx.qa
            and assigned
            and not own_other
            and run.status == "running"
            and latest.status in runs.TERMINAL,
            "can_assign": ctx.qa and run.status in {"draft", "running"} and latest.status != "running",
            "can_annotate": ctx.qa and latest.status in runs.TERMINAL,
        },
    }


def busy_accounts(ctx):
    result: set[str] = set()
    for accounts in ctx.db.scalars(
        select(m.RunItem.snapshot["accounts"])
        .join(m.Execution)
        .join(m.Run)
        .where(m.Run.project_id == ctx.project_id, m.Execution.status == "running")
    ):
        result.update(a["id"] for a in accounts)
    return result


@operation("runs:write", "tester", write=True)
def begin_run_check(ctx, run_id: str, run_item_id: str | None = None, retry: bool = False):
    """Взять следующую доступную проверку или начать конкретную. Одним вызовом запускает подготовленный прогон и резервирует вариант. Свою активную проверку возвращает повторно; чужие назначения и занятые аккаунты не захватывает. retry=true явно создаёт новую попытку указанной проверки. Возвращает check, run, guide и инструкции; реальные действия выполняет агент своим браузером/устройством/API."""
    run = ctx.get(m.Run, run_id)
    if run.status not in {"draft", "running"}:
        fail("INVALID_RUN_STATE", "Прогон закрыт. Для новой проверки создайте другой прогон.", 409)
    own = (
        ctx.db.execute(
            check_index(run.id)
            .where(m.Execution.status == "running", m.Execution.actor_id == ctx.user_id)
            .order_by(m.RunItem.position)
            .limit(1)
        )
        .mappings()
        .first()
    )
    if own:
        if run_item_id and run_item_id != own["id"]:
            fail("ACTIVE_CHECK_EXISTS", "Сначала сохраните результат своей текущей проверки.", 409)
        item = ctx.db.get(m.RunItem, own["id"])
    else:
        busy = busy_accounts(ctx)
        if retry and not run_item_id:
            fail("CHECK_REQUIRED", "Для повтора укажите проверку.")
        query = check_index(run.id).add_columns(m.RunItem.snapshot["accounts"].label("accounts"))
        if run_item_id:
            query = query.where(m.RunItem.id == run_item_id)
        else:
            query = query.where(
                m.Execution.status == "queued",
                or_(m.RunItem.assignee_id.is_(None), m.RunItem.assignee_id == ctx.user_id),
            )
        item = None
        for candidate in ctx.db.execute(query.order_by(m.RunItem.position)).mappings():
            if candidate["assignee_id"] and candidate["assignee_id"] != ctx.user_id:
                if run_item_id:
                    fail("ASSIGNED_TO_OTHER", "Эта проверка назначена другому участнику.", 409)
                continue
            if candidate["status"] != "queued" and not (retry and candidate["status"] in runs.TERMINAL):
                if run_item_id:
                    fail(
                        "INVALID_CHECK_STATE",
                        "Проверка уже выполняется или имеет результат. Для повтора используйте retry=true.",
                        409,
                    )
                continue
            if busy.intersection(a["id"] for a in (candidate["accounts"] or [])):
                if run_item_id:
                    fail(
                        "ACCOUNT_BUSY", "Нужный аккаунт занят другой проверкой. Дождитесь её завершения.", 409
                    )
                continue
            item = ctx.db.get(m.RunItem, candidate["id"])
            break
        if not item:
            if run_item_id:
                fail("NOT_FOUND", "Проверка не найдена в этом прогоне.", 404)
            return {
                "check": None,
                "run": get_run_overview(ctx, run.id),
                "message": "Свободных проверок сейчас нет: остальные уже завершены, назначены другим участникам или ожидают освобождения аккаунта.",
            }
        if run.status == "draft":
            runs.start_run(ctx, run.id, run.version)
        current = runs.attempts(ctx, item.id)[-1]
        if retry and current.status in runs.TERMINAL:
            current_id = runs.retry_execution(ctx, current.id)["id"]
        else:
            current_id = current.id
        runs.start_execution(ctx, current_id)
        ctx.db.flush()
    return {
        "check": get_run_check(ctx, item.id),
        "run": get_run_overview(ctx, run.id),
        "guide": ctx.project.guide,
        "instructions": "Выполните закреплённые шаги реальными инструментами. Запишите наблюдения по шагам и итог через finish_run_check. Ожидаемый отказ отрицательного варианта — passed. Не выдавайте непроверенное за успех. После ответа используйте run.next_action.",
    }


@operation("runs:write", "tester", write=True)
def finish_run_check(
    ctx,
    execution_id: str,
    status: Outcome,
    actual_result: Annotated[str, Field(min_length=1, max_length=30000)],
    step_results: Annotated[list[StepOutcome], Field(max_length=100)] = [],
    external_issue_url: str = "",
):
    """Атомарно сохранить наблюдения шагов и итог одной проверки. Для passed все закреплённые шаги должны быть явно passed (в step_results или ранее). Для failed/blocked/skipped объясните причину. Следующая проверка НЕ запускается автоматически: ответ содержит run.next_action. Исходный результат после сохранения неизменяем."""
    execution, item, run = runs.execution_context(ctx, execution_id, True)
    if execution.status != "running" or execution.actor_id != ctx.user_id:
        fail("EXECUTION_NOT_CLAIMED", "Сначала начните эту проверку.", 409)
    if not actual_result.strip():
        fail("RESULT_REQUIRED", "Опишите, что произошло или почему проверка не выполнена.")
    if external_issue_url and not external_issue_url.startswith(("http://", "https://")):
        fail("INVALID_URL", "Ссылка должна начинаться с http:// или https://")
    steps = runs.execution_steps(item)
    keys = {s["key"] for s in steps}
    supplied = [s.step_key for s in step_results]
    if len(supplied) != len(set(supplied)) or not set(supplied) <= keys:
        fail("INVALID_STEP", "Шаги должны быть уникальны и принадлежать этой закреплённой проверке.")
    merged = {
        **execution.steps,
        **{s.step_key: {"status": s.status, "actual_result": s.actual_result} for s in step_results},
    }
    if status == "passed" and any(merged.get(key, {}).get("status") != "passed" for key in keys):
        fail(
            "STEPS_INCOMPLETE",
            "Для успешного результата отметьте каждый шаг как совпавший с ожиданием. Если выполнить шаг не удалось, выберите другой итог.",
        )
    if status == "passed" and (
        not steps or any(not s["action"].strip() or not s["expected"].strip() for s in steps)
    ):
        fail(
            "INCOMPLETE_CASE",
            "В закреплённом сценарии не хватает шагов или ожиданий. Выберите scenario_issue и опишите, что уточнить",
        )
    for step in step_results:
        runs.record_step_result(ctx, execution_id, step.step_key, step.status, step.actual_result)
    result = runs.record_execution_result(ctx, execution_id, status, actual_result, external_issue_url)
    ctx.db.flush()
    return {"result": result, "run": get_run_overview(ctx, run.id)}
