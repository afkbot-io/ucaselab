from typing import Annotated, Literal

from pydantic import Field
from sqlalchemy import cast, or_, select
from sqlalchemy.dialects.postgresql import JSONB

from . import models as m
from .cases import case_revision, create_use_case, normalize_content, save_use_case_draft, semantic_diff
from .catalog import Limit, Offset, Search, Sort, order_query, page, text_filter
from .core import Text, Title
from .folders import require_folder
from .operations import fields, notify, operation, rows
from .schemas import ProposalContent, ProposalItem
from .security import fail


def proposal_data(obj):
    return fields(
        obj, "title", "kind", "status", "author_id", "target_use_case_id", "content", "decision", "version"
    )


def active_proposal(ctx, proposal_id):
    """Removed proposals are inaccessible; refresh after the project write lock."""
    obj = ctx.db.scalar(
        select(m.Proposal)
        .where(
            m.Proposal.id == proposal_id,
            m.Proposal.project_id == ctx.project_id,
            m.Proposal.archived == False,
        )
        .execution_options(populate_existing=True)
    )
    if obj is None:
        fail("NOT_FOUND", "Предложение не найдено", 404)
    return obj


def validate_proposal(ctx, content):
    import re

    if content.commit_sha and not re.fullmatch(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", content.commit_sha):
        fail("INVALID_COMMIT_SHA", "Укажите полный SHA коммита")
    if content.pull_request_url and not content.pull_request_url.startswith(("http://", "https://")):
        fail("INVALID_URL", "Ссылка на pull request должна начинаться с http:// или https://")
    targets = set()
    for item in content.items:
        retained = []
        if item.use_case_id:
            ctx.get(m.UseCase, item.use_case_id, archived=False)
        if item.folder_id:
            require_folder(ctx, item.folder_id)
        if item.action == "update_use_case":
            if not item.use_case_id or not item.base_revision_id or not item.content:
                fail("INVALID_PROPOSAL", "Изменение кейса требует case, base_revision и content")
            if item.use_case_id in targets:
                fail("DUPLICATE_TARGET", "Один кейс может изменяться только одним пунктом предложения")
            targets.add(item.use_case_id)
            case = ctx.get(m.UseCase, item.use_case_id, archived=False)
            retained = case_revision(ctx, case, item.base_revision_id).content.get("specifications", [])
        if item.action == "create_use_case" and not item.content:
            fail("INVALID_PROPOSAL", "Новый кейс требует заполненного content")
        if item.content:
            item.content = item.content.__class__.model_validate(
                normalize_content(ctx, item.content, retained)
            )


def validate_intent(kind, content, target):
    if kind == "new_use_case" and (target or any(i.action == "update_use_case" for i in content.items)):
        fail("INVALID_PROPOSAL_INTENT", "Для нового юзер-кейса не выбирайте существующий сценарий")
    if kind == "update_use_case" and not (
        target or any(i.action == "update_use_case" for i in content.items)
    ):
        fail("PROPOSAL_CASE_REQUIRED", "Найдите юзер-кейс, который предлагаете изменить")


@operation()
def list_proposals(
    ctx,
    use_case_id: str | None = None,
    status: Literal["open", "accepted", "rejected", "withdrawn"] | None = None,
    kind: Literal["implementation_change", "new_use_case", "update_use_case", "feature_idea"] | None = None,
    author_id: str | None = None,
    search: Search = "",
    sort: Sort = "created_desc",
    limit: Limit = 500,
    offset: Offset = 0,
):
    """Поиск предложений по тексту, типу, статусу, автору и кейсу. Разработчик получает только свои предложения."""
    query = select(m.Proposal).where(m.Proposal.project_id == ctx.project_id, m.Proposal.archived == False)
    if not ctx.qa:
        query = query.where(m.Proposal.author_id == ctx.user_id)
    if use_case_id:
        ctx.get(m.UseCase, use_case_id)
        query = query.where(
            or_(
                m.Proposal.target_use_case_id == use_case_id,
                cast(m.Proposal.content["items"], JSONB).contains([{"use_case_id": use_case_id}]),
            )
        )
    if status:
        query = query.where(m.Proposal.status == status)
    if kind:
        query = query.where(m.Proposal.kind == kind)
    if author_id:
        query = query.where(m.Proposal.author_id == author_id)
    query = text_filter(query, search, m.Proposal.title, cast(m.Proposal.content, JSONB))
    return page(ctx, order_query(query, m.Proposal, sort), proposal_data, limit, offset)


@operation()
def get_proposal(ctx, proposal_id: str):
    """Прочитать предложение с пунктами и решением. Разработчик видит только собственные предложения."""
    obj = active_proposal(ctx, proposal_id)
    if not ctx.qa and obj.author_id != ctx.user_id:
        fail("NOT_FOUND", "Предложение не найдено", 404)
    return proposal_data(obj)


@operation("proposals:write", write=True)
def submit_proposal(
    ctx,
    title: Title,
    kind: Literal["implementation_change", "new_use_case", "update_use_case", "feature_idea"],
    content: ProposalContent,
    target_use_case_id: str | None = None,
):
    """Предложить новый кейс, изменение существующего или описать влияние изменения кода. Кейсы создаются только после принятия QA."""
    validate_intent(kind, content, target_use_case_id)
    if target_use_case_id:
        case = ctx.get(m.UseCase, target_use_case_id, archived=False)
        if not ctx.qa:
            case_revision(
                ctx,
                case,
                ctx.db.get(m.Publication, case.current_publication_id).revision_id
                if case.current_publication_id
                else None,
            )
    validate_proposal(ctx, content)
    if (
        kind == "implementation_change"
        or content.repository
        or content.commit_sha
        or content.diff_fingerprint
    ) and (not content.repository or not (content.commit_sha or content.diff_fingerprint)):
        fail("CHANGE_REFERENCE_REQUIRED", "Укажите репозиторий и SHA коммита либо отпечаток рабочего diff")
    if content.commit_sha:
        import re

        if not re.fullmatch(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", content.commit_sha):
            fail("INVALID_COMMIT_SHA", "Укажите полный SHA коммита")
    obj = m.Proposal(
        project_id=ctx.project_id,
        title=title,
        kind=kind,
        content=content.model_dump(),
        author_id=ctx.user_id,
        target_use_case_id=target_use_case_id,
    )
    ctx.db.add(obj)
    ctx.db.flush()
    ctx.db.add(m.ProposalRevision(proposal_id=obj.id, number=1, content=obj.content, author_id=ctx.user_id))
    notify(ctx, "proposal_submitted", f"Новое предложение: {title}", "proposal", obj.id, qa_only=True)
    ctx.audit("proposal.submitted", obj.id)
    return proposal_data(obj)


@operation("proposals:write", write=True)
def update_proposal(ctx, proposal_id: str, expected_version: int, title: Title, content: ProposalContent):
    """Изменить своё открытое предложение с проверкой expected_version; сохранить новую ревизию и прежнее авторство."""
    obj = active_proposal(ctx, proposal_id)
    if obj.author_id != ctx.user_id:
        fail("FORBIDDEN", "Редактировать предложение может только автор", 403)
    if obj.status != "open":
        fail("PROPOSAL_CLOSED", "Создайте связанное предложение для дальнейших изменений", 409)
    ctx.expect(obj, expected_version)
    validate_intent(obj.kind, content, obj.target_use_case_id)
    validate_proposal(ctx, content)
    if (
        obj.kind == "implementation_change"
        or content.repository
        or content.commit_sha
        or content.diff_fingerprint
    ) and (not content.repository or not (content.commit_sha or content.diff_fingerprint)):
        fail("CHANGE_REFERENCE_REQUIRED", "Укажите источник изменения")
    obj.title, obj.content = title, content.model_dump()
    obj.version += 1
    ctx.db.add(
        m.ProposalRevision(proposal_id=obj.id, number=obj.version, content=obj.content, author_id=ctx.user_id)
    )
    ctx.audit("proposal.updated", obj.id)
    return proposal_data(obj)


@operation()
def list_proposal_revisions(ctx, proposal_id: str):
    """Прочитать историю неизменяемых ревизий доступного предложения, от новых к старым."""
    get_proposal(ctx, proposal_id)
    return {
        "items": [
            fields(o, "number", "content", "author_id")
            for o in ctx.db.scalars(
                select(m.ProposalRevision)
                .where(m.ProposalRevision.proposal_id == proposal_id)
                .order_by(m.ProposalRevision.number.desc())
            )
        ]
    }


@operation("proposals:review", "tester")
def preview_proposal(ctx, proposal_id: str):
    """Показать предлагаемые изменения и конфликты с текущими черновиками; ничего не применять."""
    obj = active_proposal(ctx, proposal_id)
    changes, conflicts = [], []
    for index, item in enumerate(obj.content["items"]):
        if item["action"] == "update_use_case":
            case = ctx.get(m.UseCase, item["use_case_id"])
            base = case_revision(ctx, case, item["base_revision_id"])
            if case.working_revision_id != base.id:
                conflicts.append(
                    {"item": index, "use_case_id": case.id, "current_revision_id": case.working_revision_id}
                )
            changes.append({"item": index, "changes": semantic_diff(base.content, item["content"])})
        elif item["action"] == "create_use_case":
            changes.append({"item": index, "changes": semantic_diff(None, item["content"])})
    return {"changes": changes, "conflicts": conflicts}


@operation("proposals:review", "tester", write=True)
def accept_proposal(ctx, proposal_id: str, expected_version: int, reason: Text = ""):
    """Принять открытое предложение с expected_version и атомарно применить подготовленные пункты к черновикам. Публикация выполняется отдельно."""
    obj = active_proposal(ctx, proposal_id)
    ctx.expect(obj, expected_version)
    if obj.status != "open":
        fail("PROPOSAL_CLOSED", "Предложение уже рассмотрено", 409)
    preview = preview_proposal(ctx, proposal_id)
    if preview["conflicts"]:
        fail("PROPOSAL_BASE_CONFLICT", "Базовые версии изменились. Автор должен обновить предложение", 409)
    mapping = []
    for index, item in enumerate(ProposalContent.model_validate(obj.content).items):
        if item.action == "create_use_case":
            result = create_use_case(ctx, item.content, item.folder_id, f"Принято предложение: {obj.title}")
        elif item.action == "update_use_case":
            case = ctx.get(m.UseCase, item.use_case_id, archived=False)
            result = save_use_case_draft(
                ctx,
                case.id,
                case.version,
                item.base_revision_id,
                item.content,
                f"Принято предложение: {obj.title}",
            )
        else:
            continue
        mapping.append({"item": index, "use_case_id": result["id"], "revision_id": result["revision_id"]})
    obj.status = "accepted"
    obj.decision = {
        "actor_id": ctx.user_id,
        "reason": reason,
        "at": m.now().isoformat(),
        "applied_items": mapping,
    }
    obj.version += 1
    notify(
        ctx,
        "proposal_decided",
        f"Предложение принято: {obj.title}",
        "proposal",
        obj.id,
        [obj.author_id],
        qa_only=False,
    )
    ctx.audit("proposal.accepted", obj.id)
    return proposal_data(obj)


@operation("proposals:review", "tester", write=True)
def reject_proposal(ctx, proposal_id: str, expected_version: int, reason: Title):
    """Отклонить открытое предложение с проверкой версии и причиной решения; кейсы не изменяются."""
    obj = active_proposal(ctx, proposal_id)
    ctx.expect(obj, expected_version)
    if obj.status != "open":
        fail("PROPOSAL_CLOSED", "Предложение уже рассмотрено", 409)
    obj.status, obj.version = "rejected", obj.version + 1
    ctx.audit("proposal.rejected", obj.id)
    obj.decision = {"actor_id": ctx.user_id, "reason": reason, "at": m.now().isoformat()}
    notify(
        ctx, "proposal_decided", f"Предложение отклонено: {obj.title}", "proposal", obj.id, [obj.author_id]
    )
    return proposal_data(obj)


@operation("proposals:write", write=True)
def withdraw_proposal(ctx, proposal_id: str, expected_version: int):
    """Отозвать своё открытое предложение с проверкой expected_version; история сохраняется."""
    obj = active_proposal(ctx, proposal_id)
    ctx.expect(obj, expected_version)
    if obj.author_id != ctx.user_id:
        fail("FORBIDDEN", "Отозвать предложение может только автор", 403)
    if obj.status != "open":
        fail("PROPOSAL_CLOSED", "Предложение уже рассмотрено", 409)
    obj.status, obj.version = "withdrawn", obj.version + 1
    ctx.audit("proposal.withdrawn", obj.id)
    return proposal_data(obj)


@operation("proposals:write", write=True)
def delete_proposal(ctx, proposal_id: str, expected_version: int):
    """Мягко удалить только отклонённое предложение с expected_version. Автор удаляет своё; QA для чужого также требует proposals:review. Решение, ревизии, обсуждения и аудит сохраняются, обычный доступ закрывается."""
    obj = active_proposal(ctx, proposal_id)
    if obj.author_id != ctx.user_id:
        if not ctx.qa:
            fail("NOT_FOUND", "Предложение не найдено", 404)
        ctx.actor.scope("proposals:review")
    ctx.expect(obj, expected_version)
    if obj.status != "rejected":
        fail("PROPOSAL_NOT_REJECTED", "Удалить можно только отклонённое предложение", 409)
    obj.archived, obj.version = True, obj.version + 1
    ctx.audit("proposal.deleted", obj.id, {"status": obj.status, "version": obj.version})
    return {"id": obj.id, "archived": True, "version": obj.version}


@operation()
def check_change_proposals(ctx, repository: str, commit_sha: str = "", diff_fingerprint: str = ""):
    """Найти свои доступные предложения для конкретного коммита или рабочего diff. Учитываются новые кейсы, правки и прежний тип implementation_change."""
    if not repository or not (commit_sha or diff_fingerprint):
        fail("CHANGE_REFERENCE_REQUIRED", "Укажите репозиторий и SHA коммита или отпечаток diff")
    items = [
        p
        for p in rows(ctx, m.Proposal)
        if (ctx.qa or p.author_id == ctx.user_id)
        and p.content.get("repository") == repository
        and p.status != "withdrawn"
        and (
            p.content.get("commit_sha") == commit_sha
            if commit_sha
            else p.content.get("diff_fingerprint") == diff_fingerprint
        )
    ]
    return {
        "covered": bool(items),
        "proposal_ids": [p.id for p in items],
        "repository": repository,
        "commit_sha": commit_sha,
        "diff_fingerprint": diff_fingerprint,
    }


@operation("proposals:review", "tester", write=True)
def prepare_proposal(
    ctx, proposal_id: str, expected_version: int, items: Annotated[list[ProposalItem], Field(max_length=100)]
):
    """QA готовит пункты create_use_case/update_use_case в открытом предложении любого автора. Сохраняет автора, исходное описание и ссылку на изменение кода. Создаёт ревизию предложения, но не меняет кейсы. После подготовки проверьте preview_proposal и вызовите accept_proposal, если применение поручено. Публикация кейсов отдельная."""
    obj = active_proposal(ctx, proposal_id)
    ctx.expect(obj, expected_version)
    if obj.status != "open":
        fail("PROPOSAL_CLOSED", "Предложение уже рассмотрено", 409)
    content = ProposalContent.model_validate({**obj.content, "items": [item.model_dump() for item in items]})
    validate_intent(obj.kind, content, obj.target_use_case_id)
    validate_proposal(ctx, content)
    prepared = content.model_dump()
    if prepared != obj.content:
        obj.content = prepared
        obj.version += 1
        ctx.db.add(
            m.ProposalRevision(
                proposal_id=obj.id, number=obj.version, content=prepared, author_id=ctx.user_id
            )
        )
        ctx.audit("proposal.prepared", obj.id, {"items": len(items)})
    return proposal_data(obj)
