import base64
import binascii
import hashlib
import secrets
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field
from sqlalchemy import func, select, tuple_

from . import models as m
from .catalog import LabelScope, Limit, Offset, Search
from .config import settings
from .operations import fields, operation
from .reports import get_report
from .runs import execution_context
from .security import fail


@operation("runs:write", "tester", write=True)
def add_execution_evidence(
    ctx,
    execution_id: str,
    filename: Annotated[str, Field(min_length=1, max_length=240)],
    content_base64: Annotated[str, Field(max_length=2800000)],
    content_type: str = "application/octet-stream",
):
    """Приложить доказательство к выполняемой проверке. До 2 МБ через MCP; до 20 МБ через multipart REST upload."""
    execution, _, run = execution_context(ctx, execution_id)
    if execution.status != "running" or execution.actor_id != ctx.user_id or run.status != "running":
        fail("EXECUTION_IMMUTABLE", "Добавьте доказательство во время своей активной проверки", 409)
    try:
        data = base64.b64decode(content_base64, validate=True)
    except (ValueError, binascii.Error):
        fail("INVALID_BASE64", "Некорректное содержимое файла")
    if len(data) > 2 * 1024 * 1024:
        fail("FILE_TOO_LARGE", "Через MCP можно приложить файл до 2 МБ", 413)
    storage_key = secrets.token_hex(32)
    Path(settings().storage_path).mkdir(parents=True, exist_ok=True)
    path = Path(settings().storage_path) / storage_key
    path.write_bytes(data)
    attachment = m.Attachment(
        project_id=ctx.project_id,
        execution_id=execution_id,
        author_id=ctx.user_id,
        filename=Path(filename).name,
        content_type=content_type[:120],
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        storage_key=storage_key,
    )
    ctx.db.add(attachment)
    ctx.db.flush()
    ctx.audit("evidence.added", attachment.id)
    return fields(attachment, "filename", "size", "sha256")


@operation()
def get_attachment_download(ctx, attachment_id: str):
    """Получить защищённый путь скачивания. Отправляйте свой Bearer-токен заголовком, не добавляйте его в URL."""
    attachment = ctx.get(m.Attachment, attachment_id)
    return {
        "path": f"/api/projects/{ctx.project_id}/attachments/{attachment.id}",
        "method": "GET",
        "authentication": "Bearer or browser session",
        **fields(attachment, "filename", "size", "sha256"),
    }


@operation()
def get_report_download(ctx, report_id: str, format: Literal["json", "csv", "pdf"] = "pdf"):
    """Получить защищённый путь скачивания неизменяемого отчёта."""
    get_report(ctx, report_id)
    return {
        "path": f"/api/projects/{ctx.project_id}/reports/{report_id}/download?format={format}",
        "method": "GET",
        "authentication": "Bearer or browser session",
    }


@operation()
def list_tags(
    ctx, scope: LabelScope = "use_cases", search: Search = "", limit: Limit = 30, offset: Offset = 0
):
    """Отдельные словари: use_cases — теги кейсов, specifications — теги спецификаций, platforms — платформы. QA видит ранее введённые значения, разработчик — только доступные ему данные."""
    from .cases import visible_case_query

    if ctx.qa or scope == "specifications":
        values = list(
            ctx.db.scalars(
                select(m.ProjectLabel.value).where(
                    m.ProjectLabel.project_id == ctx.project_id, m.ProjectLabel.scope == scope
                )
            )
        )
    else:
        field = "platforms" if scope == "platforms" else "tags"
        values = [
            v
            for _, revision, _ in ctx.db.execute(visible_case_query(ctx))
            for v in revision.content.get(field, [])
        ]
    if scope == "platforms":
        values += ["Web", "iOS", "Android", "API", "Desktop"]
    unique = {v.casefold(): v for v in values if search.casefold() in v.casefold()}
    values = sorted(unique.values(), key=str.casefold)
    return {
        "items": values[offset : offset + limit],
        "total": len(values),
        "next_offset": offset + limit if offset + limit < len(values) else None,
    }


@operation()
def get_coverage(ctx, search: Search = "", limit: Limit = 500, offset: Offset = 0):
    """Покрытие текущих опубликованных версий: старые успешные проверки не окрашивают новую публикацию."""
    from .cases import list_use_cases

    cases = list_use_cases(ctx, search=search, limit=limit, offset=offset)
    links = [
        (case["id"], case["current_publication_id"])
        for case in cases["items"]
        if case["current_publication_id"]
    ]
    # PostgreSQL DISTINCT ON keeps the newest result; the window count includes all attempts.
    latest = (
        {
            row.use_case_id: row
            for row in ctx.db.execute(
                select(
                    m.RunItem.use_case_id,
                    m.Execution.status,
                    func.count(m.Execution.id)
                    .over(partition_by=m.RunItem.use_case_id)
                    .label("execution_count"),
                )
                .join(m.Execution, m.Execution.run_item_id == m.RunItem.id)
                .where(tuple_(m.RunItem.use_case_id, m.RunItem.publication_id).in_(links))
                .distinct(m.RunItem.use_case_id)
                .order_by(m.RunItem.use_case_id, m.Execution.created_at.desc(), m.Execution.id.desc())
            )
        }
        if links
        else {}
    )
    return {
        "items": [
            {
                "use_case_id": case["id"],
                "key": case["key"],
                "title": case["title"],
                "publication_id": case["current_publication_id"],
                "latest_status": latest[case["id"]].status if case["id"] in latest else None,
                "execution_count": latest[case["id"]].execution_count if case["id"] in latest else 0,
            }
            for case in cases["items"]
        ],
        "total": cases["total"],
        "next_offset": cases["next_offset"],
    }
