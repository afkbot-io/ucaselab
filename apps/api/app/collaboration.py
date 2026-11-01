import re
from typing import Annotated, Literal

from pydantic import Field, StringConstraints
from sqlalchemy import exists, func, select, true

from . import models as m
from .cases import case_data, case_revision
from .core import Title
from .discussion_targets import TargetType, target_object, target_path, target_visible, thread_target
from .notification_visibility import notification_query
from .operations import fields, notify, operation
from .schemas import Anchor
from .security import fail

Body = Annotated[str, StringConstraints(strip_whitespace=True), Field(min_length=1, max_length=20000)]


def visible_thread(ctx, thread_id, write=False):
    thread = ctx.get(m.Thread, thread_id)
    target_object(ctx, *thread_target(thread), write=write)
    if not ctx.qa and thread.visibility == "qa_team":
        fail("NOT_FOUND", "Обсуждение не найдено", 404)
    return thread


def comment_data(comment):
    return fields(comment, "thread_id", "author_id", "body", "deleted", "updated_at")


def anchor_context(ctx, case):
    revision_id = (
        case.working_revision_id
        if ctx.qa
        else ctx.db.get(m.Publication, case.current_publication_id).revision_id
    )
    revision = ctx.db.get(m.UseCaseRevision, revision_id)
    return revision_id, revision.content


def anchor_status(ctx, thread, current=None):
    if not thread.anchor or thread.target_type != "use_case":
        return None
    revision_id, content = current or anchor_context(ctx, ctx.get(m.UseCase, thread.use_case_id))
    if revision_id == thread.anchor["revision_id"]:
        return "current"
    key = thread.anchor.get("step_key") or thread.anchor.get("variant_key")
    if key and key not in {v["key"] for v in content["steps"] + content["variants"]}:
        return "target_removed"
    return "outdated"


def thread_data(ctx, thread, comments=None, path=None, current=None):
    comments = (
        comments
        if comments is not None
        else ctx.db.scalars(
            select(m.Comment).where(m.Comment.thread_id == thread.id).order_by(m.Comment.created_at)
        ).all()
    )
    return {
        **fields(thread, "use_case_id", "author_id", "anchor", "visibility", "resolved"),
        "anchor_status": anchor_status(ctx, thread, current),
        "target_type": thread.target_type,
        "target_id": thread_target(thread)[1],
        "path": (path or target_path(ctx, *thread_target(thread)))
        + ("&" if thread.target_type in {"execution", "specification"} else "?")
        + "thread="
        + thread.id,
        "comments": [comment_data(c) for c in comments],
    }


@operation()
def list_comment_threads(
    ctx,
    use_case_id: str | None = None,
    resolved: bool | None = None,
    target_type: TargetType = "use_case",
    target_id: str | None = None,
):
    """Прочитать обсуждения доступного кейса или target_type/target_id, ответы и допустимых участников. QA-ветки скрыты от разработчиков."""
    target_type, target_id = discussion_target(use_case_id, target_type, target_id)
    target = target_object(ctx, target_type, target_id)
    query = select(m.Thread).where(
        m.Thread.project_id == ctx.project_id,
        m.Thread.target_type == target_type,
        func.coalesce(m.Thread.target_id, m.Thread.use_case_id) == target_id,
    )
    if not ctx.qa:
        query = query.where(m.Thread.visibility != "qa_team")
    if resolved is not None:
        query = query.where(m.Thread.resolved == resolved)
    threads = ctx.db.scalars(query.order_by(m.Thread.created_at, m.Thread.id)).all()
    comments: dict[str, list] = {}
    if threads:
        for comment in ctx.db.scalars(
            select(m.Comment)
            .where(m.Comment.thread_id.in_([t.id for t in threads]))
            .order_by(m.Comment.created_at, m.Comment.id)
        ):
            comments.setdefault(comment.thread_id, []).append(comment)
    path = target_path(ctx, target_type, target_id) if threads else None
    current = anchor_context(ctx, target) if any(t.anchor for t in threads) else None
    return {
        "eligible_member_ids": eligible_members(ctx, target_type, target_id),
        "items": [thread_data(ctx, t, comments.get(t.id, []), path, current) for t in threads],
    }


@operation()
def get_comment_thread(ctx, thread_id: str):
    """Прочитать доступную ветку обсуждения, ответы и состояние привязки к версии сценария."""
    return thread_data(ctx, visible_thread(ctx, thread_id))


def mention_ids(body):
    return set(re.findall(r"@\{([a-f0-9-]{36})\}", body))


def eligible_members(ctx, kind, target_id, qa_only=False):
    member = m.Membership
    return list(
        ctx.db.scalars(
            select(member.user_id).where(
                member.project_id == ctx.project_id,
                true() if not qa_only else member.role != "developer",
                target_visible(kind, target_id, ctx.project_id, member.role != "developer", member.user_id),
            )
        )
    )


def comment_notify(ctx, thread, body, previous=None):
    mentions = mention_ids(body) - mention_ids(previous or "")
    participants = (
        set()
        if previous is not None
        else {c.author_id for c in ctx.db.scalars(select(m.Comment).where(m.Comment.thread_id == thread.id))}
        | {thread.author_id}
    )
    # Re-evaluate each recipient's target access before persisting or emailing anything.
    eligible = set(eligible_members(ctx, *thread_target(thread), qa_only=thread.visibility == "qa_team"))
    notify(
        ctx,
        "comment_reply",
        "Новое сообщение в обсуждении",
        "thread",
        thread.id,
        list((participants | mentions) & eligible),
        qa_only=thread.visibility == "qa_team",
    )


def discussion_target(use_case_id, target_type, target_id):
    if use_case_id:
        if target_type != "use_case" or (target_id and target_id != use_case_id):
            fail("INVALID_TARGET", "Укажите одну цель обсуждения")
        target_id = use_case_id
    if not target_id:
        fail("INVALID_TARGET", "Укажите цель обсуждения")
    return target_type, target_id


@operation("comments:write", write=True)
def create_comment_thread(
    ctx,
    body: Body,
    use_case_id: str | None = None,
    anchor: Anchor | None = None,
    target_type: TargetType = "use_case",
    target_id: str | None = None,
):
    """Создать обсуждение кейса либо предложения, спецификации, отчёта или попытки проверки через target_type/target_id. anchor только для кейсов; права наследуются от цели."""
    target_type, target_id = discussion_target(use_case_id, target_type, target_id)
    case = target_object(ctx, target_type, target_id, write=True)
    if anchor and target_type != "use_case":
        fail("INVALID_ANCHOR", "Привязка к тексту доступна только для кейса")
    visibility = "project"
    if anchor:
        revision = case_revision(ctx, case, anchor.revision_id)
        publication = ctx.db.scalar(select(m.Publication.id).where(m.Publication.revision_id == revision.id))
        if not publication:
            visibility = "qa_team"
        if anchor.step_key and anchor.step_key not in {s["key"] for s in revision.content["steps"]}:
            fail("INVALID_ANCHOR", "Шаг не найден в указанной версии")
        if anchor.variant_key and anchor.variant_key not in {v["key"] for v in revision.content["variants"]}:
            fail("INVALID_ANCHOR", "Вариант не найден в указанной версии")
    elif target_type == "use_case" and not case.current_publication_id:
        visibility = "qa_team"
    thread = m.Thread(
        project_id=ctx.project_id,
        use_case_id=case.id if target_type == "use_case" else None,
        target_type=target_type,
        target_id=target_id,
        author_id=ctx.user_id,
        anchor=anchor.model_dump() if anchor else None,
        visibility=visibility,
    )
    ctx.db.add(thread)
    ctx.db.flush()
    ctx.db.add(m.Comment(thread_id=thread.id, author_id=ctx.user_id, body=body))
    ctx.db.flush()
    comment_notify(ctx, thread, body)
    ctx.audit("discussion.created", thread.id)
    return thread_data(ctx, thread)


@operation("comments:write", write=True)
def create_comment(ctx, thread_id: str, body: Body):
    """Добавить ответ в доступное обсуждение и уведомить участников с учётом их настроек."""
    thread = visible_thread(ctx, thread_id, write=True)
    comment = m.Comment(thread_id=thread.id, author_id=ctx.user_id, body=body)
    ctx.db.add(comment)
    ctx.db.flush()
    comment_notify(ctx, thread, body)
    ctx.audit("discussion.replied", thread.id)
    return comment_data(comment)


@operation("comments:write", write=True)
def update_comment(ctx, comment_id: str, body: Body):
    """Изменить свой действующий комментарий; прежний текст сохраняется в истории редактирования."""
    comment = ctx.db.get(m.Comment, comment_id)
    if not comment:
        fail("NOT_FOUND", "Комментарий не найден", 404)
    thread = visible_thread(ctx, comment.thread_id, write=True)
    if comment.author_id != ctx.user_id or comment.deleted:
        fail("FORBIDDEN", "Редактировать можно только свой действующий комментарий", 403)
    if comment.body == body:
        return comment_data(comment)
    comment.history = [*comment.history, {"body": comment.body, "at": m.now().isoformat()}]
    comment_notify(ctx, thread, body, previous=comment.body)
    comment.body, comment.updated_at = body, m.now()
    ctx.audit("discussion.edited", thread.id)
    return comment_data(comment)


@operation("comments:write", write=True)
def delete_comment(ctx, comment_id: str):
    """Удалить текст своего комментария, сохранив место в обсуждении и историю."""
    comment = ctx.db.get(m.Comment, comment_id)
    if not comment:
        fail("NOT_FOUND", "Комментарий не найден", 404)
    thread = visible_thread(ctx, comment.thread_id, write=True)
    if comment.author_id != ctx.user_id:
        fail("FORBIDDEN", "Удалять можно только свой комментарий", 403)
    comment.history = [*comment.history, {"body": comment.body, "at": m.now().isoformat()}]
    comment.body, comment.deleted, comment.updated_at = "", True, m.now()
    ctx.audit("discussion.deleted", thread.id)
    return comment_data(comment)


@operation("comments:moderate", "tester", write=True)
def moderate_comment(ctx, comment_id: str, reason: Title):
    """Скрыть комментарий с обязательной причиной; сохранить текст и автора действия в истории и аудите."""
    comment = ctx.db.get(m.Comment, comment_id)
    if not comment:
        fail("NOT_FOUND", "Комментарий не найден", 404)
    thread = visible_thread(ctx, comment.thread_id, write=True)
    comment.history = [
        *comment.history,
        {"body": comment.body, "at": m.now().isoformat(), "moderator_id": ctx.user_id, "reason": reason},
    ]
    comment.body, comment.deleted, comment.updated_at = "", True, m.now()
    ctx.audit("comment.moderated", comment.id, {"reason": reason})
    ctx.audit("discussion.moderated", thread.id)
    return comment_data(comment)


@operation("comments:write", write=True)
def resolve_comment_thread(ctx, thread_id: str, resolved: bool = True):
    """Завершить или переоткрыть обсуждение. Разработчик может менять состояние только своей ветки."""
    thread = visible_thread(ctx, thread_id, write=True)
    if not ctx.qa and thread.author_id != ctx.user_id:
        fail("FORBIDDEN", "Закрыть обсуждение может автор или тестировщик", 403)
    if thread.resolved != resolved:
        ctx.audit("discussion.resolved" if resolved else "discussion.reopened", thread.id)
    thread.resolved = resolved
    return thread_data(ctx, thread)


@operation("notifications:read")
def list_notifications(ctx, unread_only: bool = False):
    """Прочитать до 200 последних доступных уведомлений проекта. Видимость заново проверяется по текущей роли до ограничения списка."""
    return {
        "items": [
            fields(n, "event", "title", "resource_type", "resource_id", "read")
            for n in ctx.db.scalars(
                notification_query(ctx, unread_only).order_by(m.Notification.created_at.desc()).limit(200)
            )
        ]
    }


@operation("notifications:read")
def get_project_attention(ctx):
    """Счётчики внимания для меню проекта: непрочитанные уведомления, предложения на рассмотрении QA и прогоны с назначенными незавершёнными проверками. Учитываются текущая роль и видимость; связанные события одного объекта не дублируются."""
    query = notification_query(ctx, unread_only=True)
    unread_count = ctx.db.scalar(select(func.count()).select_from(query.subquery()))
    resources = list(
        ctx.db.execute(
            query.with_only_columns(m.Notification.resource_type, m.Notification.resource_id).distinct()
        )
    )
    sections: dict[str, set[str]] = {
        name: set()
        for name in (
            "cases",
            "plans",
            "runs",
            "proposals",
            "specifications",
            "accounts",
            "reports",
            "settings",
        )
    }
    thread_ids = [resource_id for kind, resource_id in resources if kind == "thread"]
    thread_targets = (
        {t.id: thread_target(t) for t in ctx.db.scalars(select(m.Thread).where(m.Thread.id.in_(thread_ids)))}
        if thread_ids
        else {}
    )
    for kind, resource_id in resources:
        if kind == "thread":
            kind, resource_id = thread_targets.get(resource_id, ("", resource_id))
        section = {
            "use_case": "cases",
            "proposal": "proposals",
            "run": "runs",
            "execution": "runs",
            "report": "reports",
            "specification": "specifications",
            "project": "settings",
        }.get(kind)
        if section:
            sections[section].add(resource_id)
    pending = []
    assigned = set()
    if ctx.qa:
        pending = list(
            ctx.db.scalars(
                select(m.Proposal.id).where(
                    m.Proposal.project_id == ctx.project_id,
                    m.Proposal.archived == False,
                    m.Proposal.status == "open"
                )
            )
        )
        sections["proposals"].update(pending)
        latest_number = (
            select(func.max(m.Execution.attempt))
            .where(m.Execution.run_item_id == m.RunItem.id)
            .correlate(m.RunItem)
            .scalar_subquery()
        )
        unfinished = exists().where(
            m.Execution.run_item_id == m.RunItem.id,
            m.Execution.attempt == latest_number,
            m.Execution.status.in_(["queued", "running"]),
        )
        assigned = set(
            ctx.db.scalars(
                select(m.RunItem.run_id)
                .join(m.Run, m.RunItem.run_id == m.Run.id)
                .where(
                    m.Run.project_id == ctx.project_id,
                    m.Run.status.in_(["draft", "running"]),
                    m.RunItem.assignee_id == ctx.user_id,
                    unfinished,
                )
                .distinct()
            )
        )
        sections["runs"].update(assigned)
    from .activity import activity_unread

    return {
        "project_id": ctx.project_id,
        "unread_notifications": unread_count,
        "unread_activity": activity_unread(ctx),
        "pending_proposals": len(pending),
        "assigned_runs": len(assigned),
        "sections": {name: len(values) for name, values in sections.items()},
    }


@operation("notifications:write", write=True)
def mark_notifications_read(ctx, notification_ids: list[str] = [], all_read: bool = False):
    """Пометить выбранные уведомления или все свои уведомления проекта прочитанными."""
    if len(notification_ids) > 200:
        fail("TOO_MANY_ITEMS", "Выберите до 200 уведомлений")
    for n in ctx.db.scalars(
        select(m.Notification).where(
            m.Notification.project_id == ctx.project_id, m.Notification.user_id == ctx.user_id
        )
    ):
        if all_read or n.id in notification_ids:
            n.read = True
    return {"ok": True}


@operation("notifications:read")
def get_notification_preferences(ctx):
    """Прочитать свои настройки уведомлений проекта и доступность отправки почты на сервере."""
    from .config import settings

    return {
        "preferences": ctx.actor.user.preferences.get(ctx.project_id, {}),
        "email_enabled": settings().email_enabled,
    }


@operation("notifications:write", write=True)
def update_notification_preferences(ctx, preferences: dict[str, bool]):
    """Заменить свои настройки уведомлений проекта; допускаются только известные события и булевы значения."""
    allowed = {
        "email",
        "comment_reply",
        "assignment",
        "proposal_submitted",
        "proposal_decided",
        "use_case_published",
        "run_finished",
        "run_cancelled",
        "report_ready",
        "role_changed",
    }
    if not set(preferences) <= allowed:
        fail("INVALID_PREFERENCES", "Неизвестный тип уведомления")
    ctx.db.refresh(ctx.actor.user, with_for_update=True)
    ctx.actor.user.preferences = {**ctx.actor.user.preferences, ctx.project_id: preferences}
    return {"preferences": preferences}


@operation("notifications:write", write=True)
def subscribe(
    ctx,
    resource_type: Literal["use_case", "thread", "proposal", "plan", "run"],
    resource_id: str,
    level: Literal["important", "all", "muted"] = "important",
):
    """Создать или изменить свою подписку на доступный ресурс проекта; muted отключает уведомления этого ресурса."""
    models = {
        "use_case": m.UseCase,
        "thread": m.Thread,
        "proposal": m.Proposal,
        "plan": m.CasePlan,
        "run": m.Run,
    }
    if resource_type == "thread":
        visible_thread(ctx, resource_id)
    else:
        obj = ctx.get(models[resource_type], resource_id)
        if resource_type == "use_case":
            case_data(ctx, obj)
        if resource_type == "proposal":
            from .proposals import get_proposal

            get_proposal(ctx, resource_id)
    obj = ctx.db.scalar(
        select(m.Subscription).where(
            m.Subscription.user_id == ctx.user_id,
            m.Subscription.project_id == ctx.project_id,
            m.Subscription.resource_type == resource_type,
            m.Subscription.resource_id == resource_id,
        )
    )
    if obj:
        obj.level = level
    else:
        obj = m.Subscription(
            project_id=ctx.project_id,
            user_id=ctx.user_id,
            resource_type=resource_type,
            resource_id=resource_id,
            level=level,
        )
        ctx.db.add(obj)
        ctx.db.flush()
    return fields(obj, "resource_type", "resource_id", "level")


@operation("notifications:read")
def list_my_subscriptions(ctx):
    """Прочитать свои подписки в выбранном проекте и их уровни уведомлений."""
    return {
        "items": [
            fields(o, "resource_type", "resource_id", "level")
            for o in ctx.db.scalars(
                select(m.Subscription).where(
                    m.Subscription.project_id == ctx.project_id, m.Subscription.user_id == ctx.user_id
                )
            )
        ]
    }


@operation("notifications:write", write=True)
def unsubscribe(ctx, subscription_id: str):
    """Удалить только свою подписку в выбранном проекте."""
    subscription = ctx.get(m.Subscription, subscription_id)
    if subscription.user_id != ctx.user_id:
        fail("NOT_FOUND", "Подписка не найдена", 404)
    ctx.db.delete(subscription)
    return {"ok": True}
