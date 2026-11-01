"""Shared current-access policy for in-app notifications, counters and email delivery."""

from sqlalchemy import Select, and_, exists, false, or_, select, true

from . import models as m
from .operations import Context


def notification_query(ctx: Context, unread_only: bool = False) -> Select[tuple[m.Notification]]:
    """Filter with SQL EXISTS so counters and lists share current visibility without N+1 reads."""
    n = m.Notification
    qa = true() if ctx.qa else false()
    from sqlalchemy import func

    from .discussion_targets import target_visible

    thread_visible = exists(
        select(m.Thread.id).where(
            m.Thread.id == n.resource_id,
            m.Thread.project_id == ctx.project_id,
            or_(qa, m.Thread.visibility != "qa_team"),
            target_visible(
                m.Thread.target_type,
                func.coalesce(m.Thread.target_id, m.Thread.use_case_id),
                ctx.project_id,
                qa,
                ctx.user_id,
            ),
        )
    )
    proposal_visible = exists().where(
        m.Proposal.id == n.resource_id,
        m.Proposal.project_id == ctx.project_id,
        m.Proposal.archived == False,
        or_(qa, m.Proposal.author_id == ctx.user_id),
    )
    report_visible = exists().where(
        m.Report.id == n.resource_id,
        m.Report.project_id == ctx.project_id,
        or_(qa, m.Report.audience != "qa_team"),
    )
    run_visible = exists().where(
        m.Run.id == n.resource_id,
        m.Run.project_id == ctx.project_id,
        or_(qa, m.Run.case_source != "draft"),
    )
    case_visible = exists().where(
        m.UseCase.id == n.resource_id,
        m.UseCase.project_id == ctx.project_id,
        or_(qa, m.UseCase.current_publication_id.is_not(None)),
    )
    query = select(n).where(
        n.project_id == ctx.project_id,
        n.user_id == ctx.user_id,
        or_(
            and_(n.resource_type == "thread", thread_visible),
            and_(n.resource_type == "proposal", proposal_visible),
            and_(n.resource_type == "report", report_visible),
            and_(n.resource_type == "run", run_visible),
            and_(n.resource_type == "use_case", case_visible),
            and_(n.resource_type == "project", n.resource_id == ctx.project_id),
        ),
    )
    return query.where(n.read == False) if unread_only else query
