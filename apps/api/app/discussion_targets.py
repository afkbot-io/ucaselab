"""Canonical object access for discussions, notification delivery and business activity."""

from typing import Literal

from sqlalchemy import and_, exists, or_, select

from . import models as m
from .security import fail

TargetType = Literal["use_case", "proposal", "specification", "report", "execution"]


def target_visible(kind, target_id, project_id, qa, user_id):
    """SQL policy: filter current object visibility before pagination or counting."""

    def object_exists(model, *conditions):
        return exists().where(model.id == target_id, model.project_id == project_id, *conditions)

    execution = exists(
        select(m.Execution.id)
        .join(m.RunItem)
        .join(m.Run)
        .where(
            m.Execution.id == target_id,
            m.Run.project_id == project_id,
            or_(qa, m.Run.case_source != "draft"),
        )
    )
    return or_(
        and_(
            kind == "use_case",
            object_exists(m.UseCase, or_(qa, m.UseCase.current_publication_id.is_not(None))),
        ),
        and_(
            kind == "proposal",
            object_exists(m.Proposal, m.Proposal.archived == False, or_(qa, m.Proposal.author_id == user_id)),
        ),
        and_(kind == "specification", object_exists(m.Specification)),
        and_(kind == "report", object_exists(m.Report, or_(qa, m.Report.audience != "qa_team"))),
        and_(kind == "execution", execution),
        and_(kind == "plan", object_exists(m.CasePlan)),
        and_(kind == "run", object_exists(m.Run, or_(qa, m.Run.case_source != "draft"))),
    )


def target_object(ctx, kind, target_id, write=False):
    if kind == "execution":
        obj = ctx.db.get(m.Execution, target_id)
        if not obj:
            fail("NOT_FOUND", "Попытка не найдена", 404)
        item = ctx.db.get(m.RunItem, obj.run_item_id)
        ctx.get(m.Run, item.run_id)
        return obj
    models = {
        "use_case": m.UseCase,
        "proposal": m.Proposal,
        "specification": m.Specification,
        "report": m.Report,
    }
    if kind == "proposal":
        from .proposals import active_proposal

        obj = active_proposal(ctx, target_id)
    else:
        obj = ctx.get(models[kind], target_id, archived=not write)
    if kind == "use_case":
        from .cases import case_data

        case_data(ctx, obj)
    elif kind == "proposal" and not ctx.qa and obj.author_id != ctx.user_id:
        fail("NOT_FOUND", "Предложение не найдено", 404)
    elif kind == "report" and not ctx.qa and obj.audience == "qa_team":
        fail("NOT_FOUND", "Отчёт не найден", 404)
    return obj


def thread_target(thread) -> tuple[str, str]:
    return thread.target_type, thread.target_id or thread.use_case_id


def target_path(ctx, kind, target_id):
    section = {
        "use_case": "cases",
        "proposal": "proposals",
        "specification": "specifications",
        "report": "reports",
    }
    if kind == "execution":
        execution = ctx.db.get(m.Execution, target_id)
        item = ctx.db.get(m.RunItem, execution.run_item_id)
        return f"/p/{ctx.project_id}/runs/{item.run_id}?check={item.id}&execution={target_id}"
    if kind == "specification":
        return f"/p/{ctx.project_id}/specifications?open={target_id}"
    return f"/p/{ctx.project_id}/{section[kind]}/{target_id}"
