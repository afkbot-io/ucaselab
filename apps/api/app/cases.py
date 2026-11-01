from typing import Any, Literal

from sqlalchemy import case as sql_case
from sqlalchemy import cast, func, select
from sqlalchemy.dialects.postgresql import JSONB

from . import models as m
from .catalog import Limit, Offset, Search, remember_labels, text_filter
from .core import Text, Title
from .folders import require_folder
from .operations import fields, notify, operation
from .schemas import CaseContent, SpecLink
from .security import content_hash, fail


def case_revision(ctx, case, revision_id=None):
    revision = ctx.db.get(m.UseCaseRevision, revision_id or case.working_revision_id)
    if not revision or revision.use_case_id != case.id:
        fail("NOT_FOUND", "Версия кейса не найдена", 404)
    if not ctx.qa:
        published = ctx.db.scalar(
            select(m.Publication.id).where(
                m.Publication.use_case_id == case.id, m.Publication.revision_id == revision.id
            )
        )
        if not published:
            fail("NOT_FOUND", "Опубликованная версия не найдена", 404)
    return revision


def normalize_content(ctx, content, retained_specifications=()):
    data = content.model_dump()
    data["tags"] = remember_labels(ctx, data["tags"], "use_cases")
    data["platforms"] = remember_labels(ctx, data["platforms"], "platforms")
    retained = {(link["specification_id"], link.get("revision_id")) for link in retained_specifications}
    spec_ids = set()
    for link in data["specifications"]:
        spec = ctx.get(m.Specification, link["specification_id"])
        if spec.archived and (spec.id, link["revision_id"]) not in retained:
            fail(
                "SPECIFICATION_ARCHIVED",
                "Спецификация удалена. Восстановите её, чтобы добавить новую связь",
                409,
            )
        if spec.id in spec_ids:
            fail("DUPLICATE_SPECIFICATION", "Спецификация указана дважды")
        spec_ids.add(spec.id)
        revision = ctx.db.get(m.SpecificationRevision, link["revision_id"] or spec.current_revision_id)
        if not revision or revision.specification_id != spec.id:
            fail("INVALID_SPECIFICATION_REVISION", "Версия спецификации не принадлежит ей")
        link["revision_id"] = revision.id
    for link in data["accounts"]:
        ctx.get(m.TestAccount, link["account_id"], archived=False)
    return data


def add_revision(ctx, case, data, message):
    revision = m.UseCaseRevision(
        use_case_id=case.id,
        number=case.version,
        author_id=ctx.user_id,
        message=message,
        content=data,
        content_hash=content_hash(data),
    )
    ctx.db.add(revision)
    ctx.db.flush()
    for variant in data["variants"]:
        ctx.db.add(
            m.CaseVariant(
                revision_id=revision.id,
                variant_key=variant["key"],
                polarity=variant["polarity"],
                content=variant,
            )
        )
    for link in data["specifications"]:
        ctx.db.add(
            m.CaseSpecification(
                revision_id=revision.id,
                specification_id=link["specification_id"],
                specification_revision_id=link["revision_id"],
            )
        )
    for link in data["accounts"]:
        ctx.db.add(m.CaseAccount(revision_id=revision.id, account_id=link["account_id"], alias=link["alias"]))
    case.working_revision_id, case.title = revision.id, data["title"]
    return revision


def case_data(ctx, case, include_content=False, published_only=False, loaded=None):
    publication = (
        loaded[1]
        if loaded
        else (ctx.db.get(m.Publication, case.current_publication_id) if case.current_publication_id else None)
    )
    visible_revision_id = (
        publication.revision_id
        if (published_only or not ctx.qa) and publication
        else case.working_revision_id
    )
    if (published_only or not ctx.qa) and not publication:
        fail("NOT_FOUND", "Опубликованный кейс не найден", 404)
    revision = loaded[0] if loaded else case_revision(ctx, case, visible_revision_id)
    result = fields(case, "key", "folder_id", "version", "archived")
    result.update(
        title=revision.content["title"],
        revision_id=revision.id,
        working_revision_id=case.working_revision_id if ctx.qa else None,
        current_publication_id=case.current_publication_id,
        publication_number=publication.number if publication else None,
        has_unpublished_changes=bool(
            ctx.qa and (not publication or publication.revision_id != case.working_revision_id)
        ),
        priority=revision.content.get("priority", "normal"),
        tags=revision.content.get("tags", []),
        platforms=revision.content.get("platforms", []),
    )
    if include_content:
        result["content"] = revision.content
    return result


def visible_case_query(ctx, archived=False):
    revision_id = m.UseCase.working_revision_id if ctx.qa else m.Publication.revision_id
    return (
        select(m.UseCase, m.UseCaseRevision, m.Publication)
        .outerjoin(m.Publication, m.Publication.id == m.UseCase.current_publication_id)
        .join(m.UseCaseRevision, m.UseCaseRevision.id == revision_id)
        .where(m.UseCase.project_id == ctx.project_id, m.UseCase.archived == archived)
    )


@operation()
def list_use_cases(
    ctx,
    folder_id: str | None = None,
    search: Search = "",
    archived: bool = False,
    limit: Limit = 500,
    offset: Offset = 0,
    without_folder: bool = False,
    include_subfolders: bool = False,
    status: Literal["all", "published", "draft"] = "all",
    tags: list[str] = [],
    platforms: list[str] = [],
    priority: Literal["low", "normal", "high", "critical"] | None = None,
    specification_id: str | None = None,
    account_id: str | None = None,
    sort: Literal[
        "created", "created_desc", "updated", "updated_desc", "title", "title_desc", "key", "priority"
    ] = "created",
):
    """Найти видимые юзер-кейсы. Все теги и платформы применяются вместе; limit/offset и next_offset — постраничная выдача. Поиск по словам в номере и содержимом. Черновики доступны QA, разработчику — только публикации."""
    query = visible_case_query(ctx, archived)
    counts = ctx.db.execute(
        select(m.UseCase.folder_id, func.count())
        .where(m.UseCase.id.in_(query.with_only_columns(m.UseCase.id)))
        .group_by(m.UseCase.folder_id)
    ).all()
    folder_counts = {folder or "none": count for folder, count in counts}
    if folder_id:
        require_folder(ctx, folder_id, archived=True)
        from .folders import descendant_ids, folder_nodes

        selected = descendant_ids(folder_nodes(ctx), folder_id) if include_subfolders else {folder_id}
        query = query.where(m.UseCase.folder_id.in_(selected))
    if without_folder:
        query = query.where(m.UseCase.folder_id.is_(None))
    query = text_filter(query, search, m.UseCase.key, cast(m.UseCaseRevision.content, JSONB))
    if status == "published":
        query = query.where(m.UseCase.current_publication_id.is_not(None))
    if status == "draft":
        if not ctx.qa:
            query = query.where(False)
        query = query.where(m.UseCase.working_revision_id != func.coalesce(m.Publication.revision_id, ""))
    if priority:
        query = query.where(m.UseCaseRevision.content["priority"].as_string() == priority)
    for field, values in (("tags", tags), ("platforms", platforms)):
        for value in values:
            query = query.where(cast(m.UseCaseRevision.content[field], JSONB).contains([value]))
    for model, filter_value, link_column in (
        (m.CaseSpecification, specification_id, m.CaseSpecification.specification_id),
        (m.CaseAccount, account_id, m.CaseAccount.account_id),
    ):
        if filter_value:
            ctx.get(m.Specification if model is m.CaseSpecification else m.TestAccount, filter_value)
            query = query.where(
                select(model.revision_id)
                .where(model.revision_id == m.UseCaseRevision.id, link_column == filter_value)
                .exists()
            )
    total = ctx.db.scalar(select(func.count()).select_from(query.subquery()))
    columns = {
        "created": m.UseCase.created_at,
        "updated": m.UseCaseRevision.created_at,
        "title": func.lower(m.UseCaseRevision.content["title"].as_string()),
        "key": m.UseCase.key,
        "priority": sql_case(
            {"critical": 0, "high": 1, "normal": 2, "low": 3},
            value=m.UseCaseRevision.content["priority"].as_string(),
            else_=4,
        ),
    }
    column = columns[sort.removesuffix("_desc")]
    query = query.order_by(column.desc() if sort.endswith("_desc") else column, m.UseCase.id)
    result = [
        case_data(ctx, c, loaded=(r, p)) for c, r, p in ctx.db.execute(query.limit(limit).offset(offset))
    ]
    return {
        "items": result,
        "total": total,
        "total_project": sum(folder_counts.values()),
        "folder_counts": folder_counts,
        "next_offset": offset + limit if offset + limit < total else None,
    }


@operation()
def get_use_case(ctx, use_case_id: str, published_only: bool = False):
    """Прочитать кейс с содержимым доступной ревизии. Разработчик получает опубликованную версию; QA может читать черновик."""
    return case_data(ctx, ctx.get(m.UseCase, use_case_id), True, published_only)


@operation("use_cases:write", "tester", write=True)
def create_use_case(
    ctx, content: CaseContent, folder_id: str | None = None, message: Text = "Создан юзер-кейс"
):
    """Создать черновик юзер-кейса в папке или корне. Данные, шаги, спецификации и аккаунты входят в первую ревизию."""
    if folder_id:
        require_folder(ctx, folder_id)
    data = normalize_content(ctx, content)
    case = m.UseCase(
        project_id=ctx.project_id,
        key=f"{ctx.project.key}-UC-{ctx.project.next_case}",
        title=data["title"],
        folder_id=folder_id,
    )
    ctx.project.next_case += 1
    ctx.db.add(case)
    ctx.db.flush()
    add_revision(ctx, case, data, message)
    ctx.audit("use_case.created", case.id)
    return case_data(ctx, case, True)


@operation("use_cases:write", "tester", write=True)
def save_use_case_draft(
    ctx,
    use_case_id: str,
    expected_version: int,
    base_revision_id: str,
    content: CaseContent,
    message: Text = "Изменён сценарий",
    change_folder: bool = False,
    folder_id: str | None = None,
):
    """Сохранить содержимое черновика с expected_version и base_revision_id; опубликованный снимок не меняется."""
    case = ctx.get(m.UseCase, use_case_id, archived=False)
    ctx.expect(case, expected_version)
    if case.working_revision_id != base_revision_id:
        fail("REVISION_CONFLICT", "Рабочая версия изменилась", 409)
    if change_folder and folder_id:
        require_folder(ctx, folder_id)
    previous = case_revision(ctx, case)
    data = normalize_content(ctx, content, previous.content.get("specifications", []))
    changed_content = previous.content_hash != content_hash(data)
    changed_folder = change_folder and case.folder_id != folder_id
    if changed_content or changed_folder:
        case.version += 1
    if changed_content:
        add_revision(ctx, case, data, message)
        ctx.audit("use_case.draft_saved", case.id)
    if changed_folder:
        case.folder_id = folder_id
        ctx.audit("use_case.moved", case.id, {"folder_id": folder_id})
    return case_data(ctx, case, True)


@operation("use_cases:publish", "tester", write=True)
def publish_use_case(ctx, use_case_id: str, expected_version: int, revision_id: str, message: Title):
    """Опубликовать указанную рабочую ревизию с проверкой версии и обязательных полей. Существующие прогоны сохраняют прежний снимок."""
    case = ctx.get(m.UseCase, use_case_id, archived=False)
    ctx.expect(case, expected_version)
    if case.working_revision_id != revision_id:
        fail("REVISION_CONFLICT", "Публикуйте актуальную рабочую версию", 409)
    revision = case_revision(ctx, case, revision_id)
    if not revision.content["steps"] or any(
        not s["action"].strip() or not s["expected"].strip() for s in revision.content["steps"]
    ):
        fail("INCOMPLETE_CASE", "Для публикации добавьте шаги и ожидаемый результат каждого шага")
    for variant in revision.content["variants"]:
        override = variant.get("steps_override")
        if variant.get("enabled", True) and override is not None and (
            not override or any(not step["action"].strip() or not step["expected"].strip() for step in override)
        ):
            fail("INCOMPLETE_CASE", f"{variant['name']}: добавьте шаги своего пути и ожидание каждого шага")
    previous = ctx.db.get(m.Publication, case.current_publication_id) if case.current_publication_id else None
    if previous and previous.revision_id == revision_id:
        return case_data(ctx, case, True)
    publication = m.Publication(
        use_case_id=case.id,
        revision_id=revision_id,
        number=(previous.number + 1 if previous else 1),
        message=message,
        author_id=ctx.user_id,
    )
    ctx.db.add(publication)
    ctx.db.flush()
    case.current_publication_id = publication.id
    case.version += 1
    ctx.audit("use_case.published", case.id, {"publication_id": publication.id})
    notify(ctx, "use_case_published", f"Опубликован {case.key}: {case.title}", "use_case", case.id)
    return case_data(ctx, case, True)


@operation("use_cases:write", "tester", write=True)
def move_use_case(ctx, use_case_id: str, expected_version: int, folder_id: str | None = None):
    """Переместить кейс в папку кейсов или корень с проверкой expected_version; содержимое и публикации сохраняются."""
    case = ctx.get(m.UseCase, use_case_id, archived=False)
    ctx.expect(case, expected_version)
    if folder_id:
        require_folder(ctx, folder_id)
    case.folder_id = folder_id
    case.version += 1
    return case_data(ctx, case)


@operation("use_cases:write", "tester", write=True)
def copy_use_case(ctx, use_case_id: str, title: Title, folder_id: str | None = None):
    """Создать независимый черновик из доступного кейса с новым ключом. История проверок и публикации не копируются."""
    case = ctx.get(m.UseCase, use_case_id)
    data = {**case_revision(ctx, case).content, "title": title}
    return create_use_case(ctx, CaseContent.model_validate(data), folder_id, f"Копия {case.key}")


@operation()
def list_use_case_history(ctx, use_case_id: str):
    """Прочитать историю доступных ревизий и публикаций кейса; неопубликованные ревизии доступны только QA."""
    case = ctx.get(m.UseCase, use_case_id)
    case_data(ctx, case)
    publications = ctx.db.scalars(
        select(m.Publication)
        .where(m.Publication.use_case_id == case.id)
        .order_by(m.Publication.number.desc())
    ).all()
    published_ids = {p.revision_id for p in publications}
    revisions = ctx.db.scalars(
        select(m.UseCaseRevision)
        .where(m.UseCaseRevision.use_case_id == case.id)
        .order_by(m.UseCaseRevision.number.desc())
    ).all()
    return {
        "revisions": [
            fields(r, "number", "message", "author_id", "content_hash")
            for r in revisions
            if ctx.qa or r.id in published_ids
        ],
        "publications": [fields(p, "number", "message", "revision_id", "author_id") for p in publications],
    }


@operation()
def get_use_case_revision(ctx, use_case_id: str, revision_id: str):
    """Прочитать конкретную неизменяемую ревизию кейса, проверив принадлежность и доступность пользователю."""
    case = ctx.get(m.UseCase, use_case_id)
    return fields(
        case_revision(ctx, case, revision_id), "number", "message", "content", "author_id", "content_hash"
    )


def semantic_diff(before, after, path=""):
    changes: list[dict[str, Any]] = []
    if before == after:
        return changes
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(before.keys() | after.keys()):
            changes.extend(semantic_diff(before.get(key), after.get(key), f"{path}/{key}"))
    elif (
        isinstance(before, list)
        and isinstance(after, list)
        and all(isinstance(v, dict) and "key" in v for v in before + after)
    ):
        old, new = {v["key"]: v for v in before}, {v["key"]: v for v in after}
        for key in sorted(old.keys() | new.keys()):
            changes.extend(semantic_diff(old.get(key), new.get(key), f"{path}/{key}"))
        old_order, new_order = [v["key"] for v in before], [v["key"] for v in after]
        if old_order != new_order and set(old_order) == set(new_order):
            changes.append({"path": path, "kind": "moved", "before": old_order, "after": new_order})
    else:
        changes.append(
            {
                "path": path,
                "kind": "added" if before is None else ("removed" if after is None else "changed"),
                "before": before,
                "after": after,
            }
        )
    return changes


@operation()
def compare_use_case_revisions(ctx, use_case_id: str, from_revision_id: str, to_revision_id: str):
    """Сравнить две доступные ревизии по полям и стабильным ключам шагов и вариантов, включая перестановки строк."""
    case = ctx.get(m.UseCase, use_case_id)
    before, after = case_revision(ctx, case, from_revision_id), case_revision(ctx, case, to_revision_id)
    return {
        "changes": semantic_diff(before.content, after.content),
        "from_revision_id": before.id,
        "to_revision_id": after.id,
    }


@operation("use_cases:write", "tester", write=True)
def restore_use_case_revision(ctx, use_case_id: str, expected_version: int, revision_id: str):
    """Создать рабочую ревизию из исторической с проверкой expected_version. История и текущая публикация сохраняются."""
    case = ctx.get(m.UseCase, use_case_id, archived=False)
    ctx.expect(case, expected_version)
    old = case_revision(ctx, case, revision_id)
    # Historical links remain historical; restoration never substitutes newer specifications.
    case.version += 1
    add_revision(ctx, case, old.content, f"Восстановлена ревизия {old.number}")
    ctx.audit("use_case.revision_restored", case.id)
    return case_data(ctx, case, True)


@operation()
def search_project(
    ctx,
    query: Search,
    limit: Limit = 20,
    offset: Offset = 0,
    entities: list[Literal["use_cases", "specifications", "proposals", "plans", "accounts"]] = [],
):
    """Поиск по выбранным каталогам проекта. Права видимости и пагинация применяются к каждому каталогу отдельно; totals и next_offsets позволяют продолжить поиск."""
    from .core import list_specifications, list_test_accounts
    from .proposals import list_proposals
    from .runs import list_case_plans

    handlers = {
        "use_cases": list_use_cases,
        "specifications": list_specifications,
        "proposals": list_proposals,
        "plans": list_case_plans,
        "accounts": list_test_accounts,
    }
    result, totals, next_offsets = {}, {}, {}
    for entity, handler in handlers.items():
        if not entities or entity in entities:
            data = handler(ctx, search=query, limit=min(limit, 100), offset=offset)
            result[entity], totals[entity], next_offsets[entity] = (
                data["items"],
                data["total"],
                data["next_offset"],
            )
        else:
            result[entity] = []
    return {**result, "totals": totals, "next_offsets": next_offsets}


@operation("use_cases:write", "tester", write=True)
def set_use_case_specifications(
    ctx,
    use_case_id: str,
    expected_version: int,
    base_revision_id: str,
    specifications: list[SpecLink],
    message: Text = "Обновлены связи со спецификациями",
):
    """Заменить связи кейса со спецификациями, сохраняя остальные поля. Передайте полный нужный список {specification_id, revision_id?}; пустой список удаляет связи. Без revision_id закрепится текущая ревизия. Уже сохранённые архивные ссылки можно оставить с их точным revision_id. Вернётся полный кейс и новая revision_id."""
    case = ctx.get(m.UseCase, use_case_id, archived=False)
    ctx.expect(case, expected_version)
    if case.working_revision_id != base_revision_id:
        fail("REVISION_CONFLICT", "Рабочая версия изменилась", 409)
    content = CaseContent.model_validate(case_revision(ctx, case).content)
    content.specifications = specifications
    return save_use_case_draft(ctx, use_case_id, expected_version, base_revision_id, content, message)
