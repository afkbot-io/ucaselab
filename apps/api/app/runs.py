from typing import Annotated, Any, Literal

from pydantic import Field
from sqlalchemy import and_, func, select

from . import models as m
from .cases import case_revision
from .catalog import Limit, Offset, Search, Sort, order_query, page, text_filter
from .core import Text, Title
from .operations import fields, notify, operation
from .schemas import CaseSource, Outcome, PlanContent
from .security import canonical, content_hash, fail

TERMINAL = {"passed", "failed", "scenario_issue", "blocked", "skipped", "cancelled"}


def validate_assignee(ctx, user_id):
    if user_id:
        member = ctx.db.scalar(
            select(m.Membership).where(
                m.Membership.project_id == ctx.project_id, m.Membership.user_id == user_id
            )
        )
        if not member or member.role == "developer":
            fail(
                "INVALID_ASSIGNEE",
                "Исполнитель должен быть тестировщиком, менеджером или руководителем проекта",
            )


def validate_plan(ctx, content, active=False):
    if active and not content.items:
        fail("INCOMPLETE_PLAN", "Добавьте хотя бы один опубликованный сценарий перед активацией плана")
    if content.environment_id:
        ctx.get(m.Environment, content.environment_id, archived=False)
    seen = set()
    for item in content.items:
        case = ctx.get(m.UseCase, item.use_case_id, archived=False)
        if active and not case.current_publication_id:
            fail("INCOMPLETE_PLAN", "Перед активацией плана опубликуйте все включённые сценарии")
        if case.id in seen:
            fail("DUPLICATE_PLAN_ITEM", "Кейс уже включён в план")
        seen.add(case.id)
        validate_assignee(ctx, item.assignee_id)
        if item.version_policy == "fixed_publication":
            pub = ctx.db.get(m.Publication, item.publication_id) if item.publication_id else None
            if not pub or pub.use_case_id != case.id:
                fail("INVALID_PUBLICATION", "Выберите опубликованную версию кейса")
        if active:
            publication_id = (
                item.publication_id
                if item.version_policy == "fixed_publication"
                else case.current_publication_id
            )
            publication = ctx.db.get(m.Publication, publication_id)
            revision = case_revision(ctx, case, publication.revision_id)
            selected_variants(case.key, revision.content, item)


def selected_variants(case_key, content, item):
    """Resolve enabled data variants identically during activation and run preparation."""
    variants = content["variants"]
    enabled = [v for v in variants if v.get("enabled", True)]
    if item.variant_selection == "explicit":
        keys = item.variant_keys
        enabled = [v for v in enabled if v["key"] in keys]
        if not keys or len(keys) != len(set(keys)) or len(enabled) != len(keys):
            fail(
                "PLAN_SELECTION_STALE",
                f"{case_key}: выберите доступные варианты без повторений; удалённые и отключённые использовать нельзя",
                409,
            )
    if variants and not enabled:
        fail("PLAN_SELECTION_STALE", f"{case_key}: все варианты отключены", 409)
    return enabled


def plan_data(ctx, plan):
    if not ctx.qa and plan.status != "active":
        fail("NOT_FOUND", "Активный план не найден", 404)
    revision = ctx.db.get(m.PlanRevision, plan.current_revision_id)
    return {
        **fields(plan, "title", "status", "version", "archived", "current_revision_id"),
        "content": revision.content,
    }


@operation()
def list_case_plans(
    ctx,
    archived: bool = False,
    search: Search = "",
    status: Literal["draft", "active"] | None = None,
    sort: Sort = "created_desc",
    limit: Limit = 500,
    offset: Offset = 0,
):
    """Найти кейс-планы по названию и статусу с пагинацией. Разработчик видит только активные планы."""
    query = select(m.CasePlan).where(m.CasePlan.project_id == ctx.project_id, m.CasePlan.archived == archived)
    if not ctx.qa:
        query = query.where(m.CasePlan.status == "active")
    if status:
        query = query.where(m.CasePlan.status == status)
    query = text_filter(query, search, m.CasePlan.title)
    return page(ctx, order_query(query, m.CasePlan, sort), lambda p: plan_data(ctx, p), limit, offset)


@operation()
def get_case_plan(ctx, plan_id: str):
    """Прочитать текущую ревизию доступного кейс-плана и правила выбора публикаций и вариантов."""
    return plan_data(ctx, ctx.get(m.CasePlan, plan_id))


@operation("plans:write", "tester", write=True)
def create_case_plan(ctx, content: PlanContent, status: Literal["draft", "active"] = "draft"):
    """Создать версионированный кейс-план с кейсами, вариантами, исполнителями и окружением; активный план требует публикаций."""
    validate_plan(ctx, content, status == "active")
    plan = m.CasePlan(project_id=ctx.project_id, title=content.title, status=status)
    ctx.db.add(plan)
    ctx.db.flush()
    revision = m.PlanRevision(plan_id=plan.id, number=1, content=content.model_dump(), author_id=ctx.user_id)
    ctx.db.add(revision)
    ctx.db.flush()
    plan.current_revision_id = revision.id
    ctx.audit("plan.created", plan.id)
    return plan_data(ctx, plan)


@operation("plans:write", "tester", write=True)
def update_case_plan(
    ctx,
    plan_id: str,
    expected_version: int,
    content: PlanContent,
    status: Literal["draft", "active"] = "draft",
):
    """Сохранить новую ревизию плана с expected_version. Ранее созданные прогоны остаются закреплены за своим составом."""
    plan = ctx.get(m.CasePlan, plan_id, archived=False)
    ctx.expect(plan, expected_version)
    validate_plan(ctx, content, status == "active")
    plan.title, plan.status, plan.version = content.title, status, plan.version + 1
    revision = m.PlanRevision(
        plan_id=plan.id, number=plan.version, content=content.model_dump(), author_id=ctx.user_id
    )
    ctx.db.add(revision)
    ctx.db.flush()
    plan.current_revision_id = revision.id
    ctx.audit("plan.updated", plan.id)
    return plan_data(ctx, plan)


@operation("plans:write", "tester", write=True)
def copy_case_plan(ctx, plan_id: str, title: Title):
    """Создать независимый черновик плана из доступного плана; прогоны и история не копируются."""
    plan = ctx.get(m.CasePlan, plan_id)
    content = ctx.db.get(m.PlanRevision, plan.current_revision_id).content
    return create_case_plan(ctx, PlanContent.model_validate({**content, "title": title}))


@operation()
def list_case_plan_revisions(ctx, plan_id: str):
    """Прочитать доступную историю плана; разработчику доступна только текущая активная ревизия."""
    plan = ctx.get(m.CasePlan, plan_id)
    plan_data(ctx, plan)
    return {
        "items": [
            fields(o, "number", "content", "author_id")
            for o in ctx.db.scalars(
                select(m.PlanRevision)
                .where(m.PlanRevision.plan_id == plan_id)
                .order_by(m.PlanRevision.number.desc())
            )
            if ctx.qa or o.id == plan.current_revision_id
        ]
    }


def select_items(ctx, items, environment_id=None, case_source: CaseSource = "published"):
    if case_source == "draft":
        ctx.require("tester")
    env = ctx.get(m.Environment, environment_id, archived=False) if environment_id else None
    selected = []
    snapshot_bytes = 0
    for item in items:
        case = ctx.get(m.UseCase, item.use_case_id, archived=False)
        pub_id = (
            item.publication_id if item.version_policy == "fixed_publication" else case.current_publication_id
        )
        publication = ctx.db.get(m.Publication, pub_id) if pub_id and case_source == "published" else None
        if case_source == "published" and (not publication or publication.use_case_id != case.id):
            fail("PLAN_SELECTION_STALE", f"{case.key}: нет доступной опубликованной версии", 409)
        revision = case_revision(
            ctx, case, publication.revision_id if publication else case.working_revision_id
        )
        enabled = selected_variants(case.key, revision.content, item)
        accounts = []
        for link in revision.content["accounts"]:
            account = ctx.get(m.TestAccount, link["account_id"], archived=False)
            if account.environment_id and account.environment_id != environment_id:
                fail("ACCOUNT_ENVIRONMENT_MISMATCH", f"{account.name}: выберите подходящее окружение")
            accounts.append(
                {
                    "id": account.id,
                    "alias": link["alias"],
                    "name": account.name,
                    "login": account.login,
                    "description": account.description,
                    "application_role": account.application_role,
                    "environment_id": account.environment_id,
                }
            )
        validate_assignee(ctx, item.assignee_id)
        specs = [
            ctx.db.get(m.SpecificationRevision, link["revision_id"]).content
            for link in revision.content["specifications"]
        ]
        for variant in enabled or [None]:
            snapshot = {
                "key": case.key,
                "content": {**revision.content, "variants": [variant] if variant else []},
                "publication_number": publication.number if publication else None,
                "case_source": case_source,
                "revision_number": revision.number,
                "accounts": accounts,
                "specifications": specs,
                "variant": variant,
            }
            snapshot_bytes += len(canonical(snapshot).encode())
            if snapshot_bytes > 8 * 1024 * 1024:
                fail("RUN_TOO_LARGE", "Разделите план: объём снимков прогона превышает 8 МБ")
            selected.append(
                {
                    "use_case_id": case.id,
                    "publication_id": publication.id if publication else None,
                    "revision_id": revision.id,
                    "variant_key": variant["key"] if variant else None,
                    "snapshot": snapshot,
                    "assignee_id": item.assignee_id,
                }
            )
    if not selected:
        fail("EMPTY_SELECTION", "Добавьте хотя бы один кейс с доступными вариантами")
    if len(selected) > 2000:
        fail("SELECTION_TOO_LARGE", "Разделите план: максимум 2000 вариантов в одном прогоне")
    environment = (
        {k: getattr(env, k) for k in ("id", "name", "base_url", "description", "configuration")}
        if env
        else {}
    )
    return selected, environment


def direct_selection(ctx, use_case_ids, environment_id, case_source):
    """Resolve full immutable snapshots internally without repeating them in preview responses."""
    from .schemas import PlanItem

    if not use_case_ids or len(use_case_ids) > 200 or len(set(use_case_ids)) != len(use_case_ids):
        fail("INVALID_SELECTION", "Выберите от 1 до 200 различных кейсов")
    return select_items(ctx, [PlanItem(use_case_id=x) for x in use_case_ids], environment_id, case_source)


@operation("runs:write", "tester")
def preview_run(
    ctx, use_case_ids: list[str], environment_id: str | None = None, case_source: CaseSource = "published"
):
    """Предпросмотр прямого прогона: case_source=published закрепляет публикации, draft — рабочие ревизии без публикации. Возвращает краткий состав без повторения текстов кейсов, аккаунты без секретов и selection_hash для защиты от изменений до create_run. Черновики доступны только QA."""
    selected, environment = direct_selection(ctx, use_case_ids, environment_id, case_source)
    return {
        "case_source": case_source,
        "count": len(selected),
        "items": [
            {
                "use_case_id": item["use_case_id"],
                "revision_id": item["revision_id"],
                "publication_id": item["publication_id"],
                "key": item["snapshot"]["key"],
                "title": item["snapshot"]["content"]["title"],
                "revision_number": item["snapshot"]["revision_number"],
                "publication_number": item["snapshot"]["publication_number"],
                "variant_key": item["variant_key"],
                "variant_name": (item["snapshot"]["variant"] or {}).get("name"),
                "accounts": item["snapshot"]["accounts"],
            }
            for item in selected
        ],
        "environment": environment,
        "selection_hash": content_hash(
            {"items": selected, "environment": environment, "case_source": case_source}
        ),
    }


@operation("runs:write", "tester")
def preview_case_plan(ctx, plan_id: str, environment_id: str | None = None):
    """Разрешить план в точные публикации, варианты и снимки окружения. Вернуть selection_hash для подтверждения состава при create_run."""
    plan = ctx.get(m.CasePlan, plan_id, archived=False)
    revision = ctx.db.get(m.PlanRevision, plan.current_revision_id)
    content = PlanContent.model_validate(revision.content)
    env_id = environment_id or content.environment_id
    selected, environment = select_items(ctx, content.items, env_id)
    return {
        "plan_revision_id": revision.id,
        "items": selected,
        "environment": environment,
        "selection_hash": content_hash(
            {"revision": revision.id, "items": selected, "environment": environment}
        ),
        "count": len(selected),
    }


@operation("runs:write", "tester", write=True)
def create_run(
    ctx,
    title: Title,
    plan_id: str | None = None,
    expected_plan_revision_id: str | None = None,
    selection_hash: str | None = None,
    use_case_ids: list[str] = [],
    environment_id: str | None = None,
    build: str = "",
    case_source: CaseSource = "published",
    compact: bool = False,
):
    """Подготовить прогон: case_source=published (по умолчанию) или draft для рабочих ревизий без публикации. Прямой выбор поддерживает selection_hash из preview_run; план требует preview_case_plan и использует публикации. Снимки неизменяемы. compact=true возвращает get_run_overview без всех текстов кейсов. Перед началом подтвердите get_run_readiness/confirm_run_readiness; прогоны черновиков видит только QA."""
    if len(build) > 240:
        fail("INVALID_BUILD", "Название сборки слишком длинное")
    plan_revision_id = None
    if plan_id:
        if case_source != "published":
            fail(
                "INVALID_SELECTION",
                "Для проверки черновиков выберите кейсы напрямую. План закрепляет публикации.",
            )
        preview = preview_case_plan(ctx, plan_id, environment_id)
        if (
            preview["plan_revision_id"] != expected_plan_revision_id
            or preview["selection_hash"] != selection_hash
        ):
            fail("PLAN_SELECTION_CHANGED", "Состав плана изменился. Повторите предварительный просмотр", 409)
        selected, environment, plan_revision_id = (
            preview["items"],
            preview["environment"],
            preview["plan_revision_id"],
        )
    else:
        selected, environment = direct_selection(ctx, use_case_ids, environment_id, case_source)
        current_hash = content_hash(
            {"items": selected, "environment": environment, "case_source": case_source}
        )
        if selection_hash and selection_hash != current_hash:
            fail("RUN_SELECTION_CHANGED", "Кейсы или окружение изменились. Повторите preview_run", 409)
    run = m.Run(
        project_id=ctx.project_id,
        title=title,
        author_id=ctx.user_id,
        environment=environment,
        plan_revision_id=plan_revision_id,
        build=build,
        source="agent" if ctx.actor.token else "manual",
        case_source=case_source,
        readiness={"required": True},
    )
    ctx.db.add(run)
    ctx.db.flush()
    for position, entry in enumerate(selected):
        item = m.RunItem(run_id=run.id, position=position, **entry)
        ctx.db.add(item)
        ctx.db.flush()
        ctx.db.add(m.Execution(run_item_id=item.id, source=run.source))
    ctx.db.flush()
    ctx.audit("run.created", run.id)
    if compact:
        from .run_workflow import get_run_overview

        return get_run_overview(ctx, run.id)
    return get_run(ctx, run.id)


def run_items(ctx, run):
    return ctx.db.scalars(
        select(m.RunItem).where(m.RunItem.run_id == run.id).order_by(m.RunItem.position)
    ).all()


def attempts(ctx, item_id):
    return ctx.db.scalars(
        select(m.Execution).where(m.Execution.run_item_id == item_id).order_by(m.Execution.attempt)
    ).all()


def run_summary(ctx, run):
    counts = {
        status: 0
        for status in [
            "queued",
            "running",
            "passed",
            "failed",
            "scenario_issue",
            "blocked",
            "skipped",
            "cancelled",
        ]
    }
    latest = (
        select(m.Execution.run_item_id, func.max(m.Execution.attempt).label("attempt"))
        .join(m.RunItem)
        .where(m.RunItem.run_id == run.id)
        .group_by(m.Execution.run_item_id)
        .subquery()
    )
    statuses = ctx.db.scalars(
        select(m.Execution.status).join(
            latest,
            and_(m.Execution.run_item_id == latest.c.run_item_id, m.Execution.attempt == latest.c.attempt),
        )
    ).all()
    for status in statuses:
        counts[status] += 1
    conclusive = counts["passed"] + counts["failed"]
    return {
        "selected": len(statuses),
        "counts": counts,
        "coverage": conclusive / len(statuses) if statuses else None,
        "pass_rate": counts["passed"] / conclusive if conclusive else None,
    }


@operation()
def list_runs(
    ctx,
    plan_id: str | None = None,
    search: Search = "",
    status: Literal["draft", "running", "completed", "cancelled"] | None = None,
    author_id: str | None = None,
    sort: Sort = "created_desc",
    limit: Limit = 500,
    offset: Offset = 0,
    case_source: CaseSource | None = None,
):
    """Поиск прогонов по названию и сборке; фильтры case_source (draft/published), плана, автора и состояния. Разработчик видит только прогоны публикаций; сводки и total учитывают доступ."""
    query = select(m.Run).where(m.Run.project_id == ctx.project_id)
    if not ctx.qa:
        query = query.where(m.Run.case_source == "published")
    if case_source:
        query = query.where(m.Run.case_source == case_source)
    if plan_id:
        plan_data(ctx, ctx.get(m.CasePlan, plan_id))
        query = query.where(
            m.Run.plan_revision_id.in_(select(m.PlanRevision.id).where(m.PlanRevision.plan_id == plan_id))
        )
    if status:
        query = query.where(m.Run.status == status)
    if author_id:
        query = query.where(m.Run.author_id == author_id)
    query = text_filter(query, search, m.Run.title, m.Run.build)
    return page(
        ctx,
        order_query(query, m.Run, sort),
        lambda r: {
            **fields(
                r,
                "title",
                "status",
                "author_id",
                "environment",
                "build",
                "source",
                "version",
                "plan_revision_id",
                "case_source",
                "readiness",
                "finished_at",
            ),
            "summary": run_summary(ctx, r),
        },
        limit,
        offset,
    )


@operation()
def get_run(ctx, run_id: str):
    """Прочитать прогон со всеми закреплёнными снимками, попытками и результатами. Для большой очереди используйте get_run_overview и list_run_checks."""
    run = ctx.get(m.Run, run_id)
    items = []
    executions = ctx.db.scalars(
        select(m.Execution).join(m.RunItem).where(m.RunItem.run_id == run.id).order_by(m.Execution.attempt)
    ).all()
    attachments = ctx.db.scalars(
        select(m.Attachment).join(m.Execution).join(m.RunItem).where(m.RunItem.run_id == run.id)
    ).all()
    annotations = ctx.db.scalars(
        select(m.ExecutionAnnotation).join(m.Execution).join(m.RunItem).where(m.RunItem.run_id == run.id)
    ).all()
    users = dict(
        ctx.db.execute(
            select(m.User.id, m.User.name)
            .join(m.Execution, m.Execution.actor_id == m.User.id)
            .join(m.RunItem)
            .where(m.RunItem.run_id == run.id)
        ).all()
    )
    by_item: dict[str, list[dict[str, Any]]] = {}
    by_execution: dict[str, list[dict[str, Any]]] = {}
    annotation_index: dict[str, list[dict[str, Any]]] = {}
    for attachment in attachments:
        by_execution.setdefault(attachment.execution_id, []).append(
            fields(attachment, "filename", "size", "sha256")
        )
    for annotation in annotations:
        annotation_index.setdefault(annotation.execution_id, []).append(
            fields(annotation, "author_id", "body")
        )
    for e in executions:
        entry = fields(
            e,
            "attempt",
            "status",
            "actor_id",
            "source",
            "actual_result",
            "steps",
            "started_at",
            "finished_at",
            "external_issue_url",
        )
        entry.update(
            actor_name=users.get(e.actor_id),
            attachments=by_execution.get(e.id, []),
            annotations=annotation_index.get(e.id, []),
        )
        by_item.setdefault(e.run_item_id, []).append(entry)
    for item in run_items(ctx, run):
        entries = by_item.get(item.id, [])
        items.append(
            {
                **fields(
                    item,
                    "use_case_id",
                    "publication_id",
                    "revision_id",
                    "variant_key",
                    "snapshot",
                    "assignee_id",
                    "position",
                ),
                "attempts": entries,
            }
        )
    return {
        **fields(
            run,
            "title",
            "status",
            "author_id",
            "environment",
            "build",
            "source",
            "version",
            "plan_revision_id",
            "case_source",
            "readiness",
            "finished_at",
        ),
        "items": items,
        "summary": run_summary(ctx, run),
    }


@operation("runs:write", "tester", write=True)
def start_run(ctx, run_id: str, expected_version: int):
    """Перевести черновик прогона в выполнение с проверкой expected_version. Для выбора следующей проверки удобнее begin_run_check."""
    run = ctx.get(m.Run, run_id)
    ctx.expect(run, expected_version)
    if run.status != "draft":
        fail("INVALID_RUN_STATE", "Начать можно только подготовленный прогон", 409)
    from .run_readiness import require_readiness

    require_readiness(ctx, run)
    run.status, run.version = "running", run.version + 1
    return get_run(ctx, run.id)


def execution_steps(item):
    """An explicit empty override stays empty, including when reviewing incomplete drafts."""
    override = (item.snapshot.get("variant") or {}).get("steps_override")
    return override if override is not None else item.snapshot["content"]["steps"]


def execution_context(ctx, execution_id, mutable=False):
    execution = ctx.db.get(m.Execution, execution_id)
    item = ctx.db.get(m.RunItem, execution.run_item_id) if execution else None
    if not item:
        fail("NOT_FOUND", "Проверка не найдена", 404)
    run = ctx.get(m.Run, item.run_id)
    if mutable:
        if run.status != "running":
            fail("RUN_NOT_RUNNING", "Прогон должен быть запущен и оставаться активным", 409)
        if execution.status in TERMINAL:
            fail(
                "EXECUTION_IMMUTABLE",
                "Завершённый результат неизменяем. Добавьте пояснение или новую попытку",
                409,
            )
        if attempts(ctx, item.id)[-1].id != execution.id:
            fail("STALE_ATTEMPT", "Используйте последнюю попытку", 409)
    return execution, item, run


@operation()
def get_execution_bundle(ctx, execution_id: str):
    """Прочитать закреплённые данные и шаги конкретной попытки. Секреты аккаунтов выдаются отдельной операцией."""
    execution, item, run = execution_context(ctx, execution_id)
    return {
        "execution": fields(execution, "status", "attempt", "source"),
        "run_id": run.id,
        "build": run.build,
        "environment": run.environment,
        "case_source": run.case_source,
        "publication_id": item.publication_id,
        "revision_id": item.revision_id,
        "snapshot": item.snapshot,
        "guide": ctx.project.guide,
        "instructions": "Выполните сценарий реальным браузером, устройством или API. Отрицательный вариант с ожидаемым отказом считается passed. Пароли раскрываются отдельно и не записываются в результаты.",
    }


@operation("runs:write", "tester", write=True)
def start_execution(ctx, execution_id: str):
    """Начать ожидающую попытку от своего имени с проверкой назначения и занятых аккаунтов. Для обычной работы используйте begin_run_check."""
    execution, item, run = execution_context(ctx, execution_id, True)
    if execution.status == "running":
        if execution.actor_id == ctx.user_id:
            return fields(execution, "status", "actor_id")
        fail("EXECUTION_CLAIMED", "Проверка уже выполняется другим участником", 409)
    if item.assignee_id and item.assignee_id != ctx.user_id:
        fail("ASSIGNED_TO_OTHER", "Сначала переназначьте проверку", 409)
    account_ids = {a["id"] for a in item.snapshot["accounts"]}
    if account_ids:
        for other in ctx.db.scalars(
            select(m.Execution)
            .join(m.RunItem)
            .join(m.Run)
            .where(m.Run.project_id == ctx.project_id, m.Execution.status == "running")
        ):
            other_item = ctx.db.get(m.RunItem, other.run_item_id)
            if account_ids & {a["id"] for a in other_item.snapshot["accounts"]}:
                fail("ACCOUNT_BUSY", "Тестовый аккаунт уже используется в другой активной проверке", 409)
    execution.status, execution.actor_id, execution.started_at = "running", ctx.user_id, m.now()
    execution.source = "agent" if ctx.actor.token else "manual"
    return fields(execution, "status", "actor_id", "started_at")


@operation("runs:write", "tester", write=True)
def record_step_result(
    ctx,
    execution_id: str,
    step_key: str,
    status: Outcome,
    actual_result: Text,
):
    """Сохранить наблюдение и статус шага своей активной попытки. Итог проверки фиксируется отдельно."""
    execution, item, run = execution_context(ctx, execution_id, True)
    if execution.status != "running" or execution.actor_id != ctx.user_id:
        fail("EXECUTION_NOT_CLAIMED", "Начните проверку перед записью результата", 409)
    steps = execution_steps(item)
    if step_key not in {s["key"] for s in steps}:
        fail("INVALID_STEP", "Шаг не принадлежит закреплённой версии")
    execution.steps = {
        **execution.steps,
        step_key: {"status": status, "actual_result": actual_result, "at": m.now().isoformat()},
    }
    return {"steps": execution.steps}


@operation("runs:write", "tester", write=True)
def record_execution_result(
    ctx,
    execution_id: str,
    status: Outcome,
    actual_result: Annotated[str, Field(min_length=1, max_length=30000)],
    external_issue_url: str = "",
):
    """Зафиксировать итог своей активной попытки. Для passed все закреплённые шаги должны быть passed; результат после завершения неизменяем."""
    execution, item, run = execution_context(ctx, execution_id, True)
    if execution.status != "running" or execution.actor_id != ctx.user_id:
        fail("EXECUTION_NOT_CLAIMED", "Начните проверку перед записью результата", 409)
    if external_issue_url and not external_issue_url.startswith(("http://", "https://")):
        fail("INVALID_URL", "Некорректная ссылка на внешнюю задачу")
    if status == "passed" and any(
        step["status"] in {"failed", "scenario_issue", "blocked"} for step in execution.steps.values()
    ):
        fail(
            "INCONSISTENT_VERDICT",
            "Есть проваленный или заблокированный шаг. Уточните шаги либо итоговый вердикт",
        )
    steps = execution_steps(item)
    if status == "passed" and (
        not steps or any(not s["action"].strip() or not s["expected"].strip() for s in steps)
    ):
        fail(
            "INCOMPLETE_CASE",
            "В закреплённом сценарии не хватает шагов или ожиданий. Уточните сценарий либо выберите scenario_issue",
        )
    if status == "passed" and any(
        execution.steps.get(step["key"], {}).get("status") != "passed" for step in steps
    ):
        fail("STEPS_INCOMPLETE", "Перед успешным итогом сохраните результат каждого шага")
    if not actual_result.strip():
        fail("RESULT_REQUIRED", "Опишите наблюдаемый результат или причину остановки")
    execution.status, execution.actual_result = status, actual_result
    execution.external_issue_url, execution.finished_at = external_issue_url, m.now()
    ctx.audit("execution.finished", execution.id, {"status": status})
    return fields(execution, "status", "actual_result", "finished_at")


@operation("runs:write", "tester", write=True)
def retry_execution(ctx, execution_id: str):
    """Создать новую ожидающую попытку завершённой проверки внутри активного прогона; прежние результаты сохраняются."""
    execution, item, run = execution_context(ctx, execution_id)
    if (
        run.status != "running"
        or execution.status not in TERMINAL
        or attempts(ctx, item.id)[-1].id != execution.id
    ):
        fail(
            "INVALID_RETRY", "Повтор доступен для последнего завершённого результата в активном прогоне", 409
        )
    new = m.Execution(
        run_item_id=item.id, attempt=execution.attempt + 1, source="agent" if ctx.actor.token else "manual"
    )
    ctx.db.add(new)
    ctx.db.flush()
    return fields(new, "status", "attempt")


@operation("runs:write", "tester", write=True)
def assign_run_item(ctx, run_item_id: str, assignee_id: str | None = None):
    """Назначить доступного QA-участника на проверку. Во время активной попытки переназначение запрещено."""
    item = ctx.db.get(m.RunItem, run_item_id)
    if not item:
        fail("NOT_FOUND", "Элемент прогона не найден", 404)
    run = ctx.get(m.Run, item.run_id)
    if run.status not in {"draft", "running"} or attempts(ctx, item.id)[-1].status == "running":
        fail("INVALID_RUN_STATE", "Нельзя переназначить выполняемую или закрытую проверку", 409)
    validate_assignee(ctx, assignee_id)
    item.assignee_id = assignee_id
    if assignee_id:
        notify(ctx, "assignment", "Вам назначена проверка", "run", run.id, [assignee_id], qa_only=True)
    return {"ok": True}


@operation("runs:write", "tester", write=True)
def complete_run(ctx, run_id: str, expected_version: int):
    """Закрыть прогон с expected_version, когда все выбранные проверки получили конечные результаты. Ошибки и блокировки остаются в отчёте."""
    run = ctx.get(m.Run, run_id)
    ctx.expect(run, expected_version)
    summary = run_summary(ctx, run)
    if run.status != "running" or summary["counts"]["queued"] + summary["counts"]["running"] > 0:
        fail("RUN_INCOMPLETE", "Запишите результат всех выбранных проверок перед завершением", 409)
    run.status, run.version, run.finished_at = "completed", run.version + 1, m.now()
    notify(
        ctx,
        "run_finished",
        f"Завершён прогон: {run.title}",
        "run",
        run.id,
        qa_only=run.case_source == "draft",
    )
    ctx.audit("run.completed", run.id)
    return get_run(ctx, run.id)


@operation("runs:write", "tester", write=True)
def cancel_run(ctx, run_id: str, expected_version: int, reason: Title):
    """Отменить незавершённый прогон с expected_version; ожидающие и активные попытки становятся cancelled."""
    run = ctx.get(m.Run, run_id)
    ctx.expect(run, expected_version)
    if run.status not in {"draft", "running"}:
        fail("INVALID_RUN_STATE", "Прогон уже закрыт", 409)
    for item in run_items(ctx, run):
        execution = attempts(ctx, item.id)[-1]
        if execution.status not in TERMINAL:
            execution.status, execution.actual_result, execution.finished_at = "cancelled", reason, m.now()
            execution.actor_id = execution.actor_id or ctx.user_id
    run.status, run.version, run.finished_at = "cancelled", run.version + 1, m.now()
    notify(
        ctx,
        "run_cancelled",
        f"Прогон отменён: {run.title}",
        "run",
        run.id,
        qa_only=run.case_source == "draft",
    )
    ctx.audit("run.cancelled", run.id)
    return get_run(ctx, run.id)


@operation()
def get_run_report(ctx, run_id: str):
    """Прочитать актуальные итоги прогона, последние попытки и метрики без создания сохранённого отчёта."""
    run = ctx.get(m.Run, run_id)
    return {
        **fields(run, "title", "status", "build", "environment", "case_source", "readiness"),
        "summary": run_summary(ctx, run),
    }


@operation()
def list_use_case_executions(ctx, use_case_id: str):
    """Прочитать историю фактических выполнений кейса с версиями, вариантами, исполнителями и наблюдениями."""
    case = ctx.get(m.UseCase, use_case_id)
    result = []
    query = select(m.RunItem).join(m.Run).where(m.RunItem.use_case_id == case.id)
    if not ctx.qa:
        query = query.where(m.Run.case_source == "published")
    for item in ctx.db.scalars(query.order_by(m.RunItem.created_at.desc())):
        run = ctx.get(m.Run, item.run_id)
        for execution in attempts(ctx, item.id)[::-1]:
            actor = ctx.db.get(m.User, execution.actor_id) if execution.actor_id else None
            result.append(
                {
                    **fields(
                        execution,
                        "attempt",
                        "status",
                        "source",
                        "actor_id",
                        "actual_result",
                        "started_at",
                        "finished_at",
                        "external_issue_url",
                    ),
                    "actor_name": actor.name if actor else None,
                    "run_id": run.id,
                    "run_title": run.title,
                    "build": run.build,
                    "environment": run.environment,
                    "publication_id": item.publication_id,
                    "publication_number": item.snapshot["publication_number"],
                    "is_current_publication": bool(
                        item.publication_id and item.publication_id == case.current_publication_id
                    ),
                    "case_source": run.case_source,
                    "revision_id": item.revision_id,
                    "revision_number": item.snapshot.get("revision_number"),
                    "is_current_revision": item.revision_id == case.working_revision_id,
                    "variant": item.snapshot.get("variant"),
                    "annotations": [
                        fields(a, "author_id", "body")
                        for a in ctx.db.scalars(
                            select(m.ExecutionAnnotation).where(
                                m.ExecutionAnnotation.execution_id == execution.id
                            )
                        )
                    ],
                    "attachments": [
                        fields(a, "filename", "content_type", "size")
                        for a in ctx.db.scalars(
                            select(m.Attachment).where(m.Attachment.execution_id == execution.id)
                        )
                    ],
                }
            )
    return {"items": result}


@operation("runs:write", "tester", write=True)
def add_execution_annotation(
    ctx, execution_id: str, body: Annotated[str, Field(min_length=1, max_length=10000)]
):
    """Добавить пояснение к завершённой попытке. Исходный результат и ранее сохранённые отчёты не изменяются."""
    execution_context(ctx, execution_id)
    annotation = m.ExecutionAnnotation(execution_id=execution_id, author_id=ctx.user_id, body=body)
    ctx.db.add(annotation)
    ctx.db.flush()
    return fields(annotation, "body", "author_id")
