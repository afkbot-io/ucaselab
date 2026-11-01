from typing import Literal

from sqlalchemy import select

from . import models as m
from .catalog import Limit, Offset, Search, Sort, order_query, page, text_filter
from .core import Title
from .operations import fields, notify, operation, rows
from .runs import get_run
from .security import canonical, content_hash, fail


@operation()
def list_reports(
    ctx,
    search: Search = "",
    audience: Literal["project", "qa_team"] | None = None,
    interim: bool | None = None,
    author_id: str | None = None,
    sort: Sort = "created_desc",
    limit: Limit = 500,
    offset: Offset = 0,
):
    """Найти сохранённые отчёты проекта с поиском, сортировкой и пагинацией; QA-отчёты скрыты от разработчиков."""
    query = select(m.Report).where(m.Report.project_id == ctx.project_id)
    if not ctx.qa:
        query = query.where(m.Report.audience == "project")
    if audience:
        query = query.where(m.Report.audience == audience)
    if interim is not None:
        query = query.where(m.Report.interim == interim)
    if author_id:
        query = query.where(m.Report.author_id == author_id)
    query = text_filter(query, search, m.Report.title)
    return page(
        ctx,
        order_query(query, m.Report, sort),
        lambda r: fields(r, "title", "author_id", "audience", "interim", "content_hash"),
        limit,
        offset,
    )


@operation()
def get_report(ctx, report_id: str):
    """Прочитать неизменяемый снимок отчёта с проверкой его аудитории."""
    report = ctx.get(m.Report, report_id)
    if report.audience == "qa_team" and not ctx.qa:
        fail("NOT_FOUND", "Отчёт не найден", 404)
    return fields(report, "title", "author_id", "audience", "interim", "snapshot", "content_hash")


@operation("reports:write", "tester", write=True)
def generate_report(
    ctx,
    title: Title,
    run_ids: list[str],
    interim: bool = False,
    audience: Literal["project", "qa_team"] = "project",
):
    """Сохранить отчёт по последним попыткам выбранных прогонов: до 30 прогонов и 16 МБ снимка. Последующие изменения не меняют отчёт."""
    if not run_ids or len(run_ids) > 30 or len(set(run_ids)) != len(run_ids):
        fail("INVALID_RUN_SELECTION", "Выберите от 1 до 30 различных прогонов")
    snapshots = []
    for run_id in run_ids:
        run = ctx.get(m.Run, run_id)
        if not interim and run.status not in {"completed", "cancelled"}:
            fail("RUN_NOT_FINAL", "Для незавершённых прогонов создайте промежуточный отчёт", 409)
        if run.case_source == "draft":
            audience = "qa_team"
        snapshot = get_run(ctx, run_id)
        snapshots.append(snapshot)
    # Persist plain JSON, not references to live result rows or comments.
    from fastapi.encoders import jsonable_encoder

    snapshot = jsonable_encoder(
        {
            "project": {"id": ctx.project_id, "name": ctx.project.name, "key": ctx.project.key},
            "generated_at": m.now(),
            "generator": "ucaselab-report/1",
            "methodology": "Для каждого варианта взята последняя попытка. Покрытие — доля вариантов с подтверждённым результатом (успех или ошибка приложения). Доля успеха рассчитывается среди этих проверок. Неточности сценариев и препятствия учитываются отдельно; они не являются ошибками приложения. При отсутствии проверенных результатов доля успеха не определена. Завершение прогона не означает готовность релиза.",
            "runs": snapshots,
        }
    )
    if len(canonical(snapshot).encode()) > 16 * 1024 * 1024:
        fail("REPORT_TOO_LARGE", "Разделите отчёт: объём снимка превышает 16 МБ")
    report = m.Report(
        project_id=ctx.project_id,
        title=title,
        author_id=ctx.user_id,
        audience=audience,
        interim=interim,
        snapshot=snapshot,
        content_hash=content_hash(snapshot),
    )
    ctx.db.add(report)
    ctx.db.flush()
    for run_id in run_ids:
        ctx.db.add(m.ReportRun(report_id=report.id, run_id=run_id))
    notify(ctx, "report_ready", f"Готов отчёт: {title}", "report", report.id, qa_only=audience == "qa_team")
    ctx.audit("report.generated", report.id)
    return get_report(ctx, report.id)


@operation("audit:read", "manager")
def list_audit_events(ctx, limit: int = 200):
    """Прочитать последние события аудита проекта; содержимое секретов в события не входит."""
    return {
        "items": [
            fields(a, "actor_id", "action", "resource_id", "metadata_")
            for a in ctx.db.scalars(
                select(m.Audit)
                .where(m.Audit.project_id == ctx.project_id)
                .order_by(m.Audit.created_at.desc())
                .limit(min(max(limit, 1), 1000))
            )
        ]
    }


@operation("exports:read", "tester")
def export_project(ctx):
    """Экспорт активного проекта без секретов; включает независимые деревья и закреплённые ревизии спецификаций, даже если требование уже архивировано."""
    from .cases import get_use_case
    from .core import (
        get_specification,
        get_specification_revision,
        list_environments,
        list_specifications,
        list_test_accounts,
    )
    from .folders import get_specification_folder, list_folders, list_specification_folders
    from .runs import list_case_plans

    def collect(tool):
        items, offset = [], 0
        while True:
            result = tool(ctx, limit=1000, offset=offset)
            items.extend(result["items"])
            if result["next_offset"] is None:
                return items
            offset = result["next_offset"]

    cases = [get_use_case(ctx, obj.id) for obj in rows(ctx, m.UseCase)]
    specifications = {obj["id"]: obj for obj in collect(list_specifications)}
    links = [
        (link["specification_id"], link["revision_id"])
        for case in cases
        for link in case["content"]["specifications"]
    ]
    for specification_id, _ in links:
        if specification_id not in specifications:
            specifications[specification_id] = get_specification(ctx, specification_id)
    revision_keys = set(links) | {(obj["id"], obj["current_revision_id"]) for obj in specifications.values()}
    revisions = [
        get_specification_revision(ctx, spec_id, revision_id)
        for spec_id, revision_id in sorted(revision_keys)
        if revision_id
    ]
    specification_folders = {obj["id"]: obj for obj in collect(list_specification_folders)}
    for spec in specifications.values():
        folder_id = spec["folder_id"]
        while folder_id and folder_id not in specification_folders:
            folder = get_specification_folder(ctx, folder_id)
            specification_folders[folder_id] = folder
            folder_id = folder["parent_id"]
    return {
        "format": "ucaselab-project/1",
        "project": fields(ctx.project, "name", "key", "description", "guide"),
        "folders": collect(list_folders),
        "specification_folders": list(specification_folders.values()),
        "specifications": list(specifications.values()),
        "specification_revisions": revisions,
        "accounts": collect(list_test_accounts),
        "environments": list_environments(ctx)["items"],
        "use_cases": cases,
        "plans": collect(list_case_plans),
    }
