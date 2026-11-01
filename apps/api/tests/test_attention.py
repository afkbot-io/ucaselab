"""Attention counters reflect actual work and current access, including role changes."""

from datetime import timedelta

import pytest
from app import models as m
from app.operations import dispatch
from app.security import Actor
from conftest import approve_run
from fastapi import HTTPException
from sqlalchemy import event


def participant(db, project, role="tester"):
    user = m.User(email=f"{m.uid()}@example.com", name="Участник", verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    member = m.Membership(project_id=project, user_id=user.id, role=role)
    db.add(member)
    db.flush()
    return Actor(user), member


def test_proposal_attention_deduplicates_event_and_pending_work(db, owner, project, call):
    developer, _ = participant(db, project, "developer")
    proposal = dispatch(
        db,
        developer,
        "submit_proposal",
        project,
        {
            "title": "Добавить регистрацию",
            "kind": "feature_idea",
            "content": {"description": "Нужен сценарий регистрации"},
        },
    )
    attention = call("get_project_attention")
    assert attention["unread_notifications"] == 1
    assert attention["pending_proposals"] == 1
    assert attention["sections"]["proposals"] == 1
    call("mark_notifications_read", all_read=True)
    attention = call("get_project_attention")
    assert attention["unread_notifications"] == 0 and attention["sections"]["proposals"] == 1
    call("accept_proposal", proposal_id=proposal["id"], expected_version=proposal["version"])
    assert call("get_project_attention")["sections"]["proposals"] == 0
    developer_attention = dispatch(db, developer, "get_project_attention", project)
    assert developer_attention["pending_proposals"] == 0
    assert developer_attention["unread_notifications"] == developer_attention["sections"]["proposals"] == 1


def test_old_qa_notifications_disappear_after_downgrade_and_filter_precedes_limit(db, project, call, content):
    actor, member = participant(db, project)
    case = call("create_use_case", content=content)
    run = call("create_run", title="Закрытая проверка", use_case_ids=[case["id"]], case_source="draft")
    thread = call("create_comment_thread", use_case_id=case["id"], body="QA only")
    for _ in range(205):
        db.add(
            m.Notification(
                project_id=project,
                user_id=actor.user.id,
                event="assignment",
                title="QA notification",
                resource_type="run",
                resource_id=run["id"],
            )
        )
    db.add(
        m.Notification(
            project_id=project,
            user_id=actor.user.id,
            event="comment_reply",
            title="Private thread",
            resource_type="thread",
            resource_id=thread["id"],
        )
    )
    proposal = dispatch(
        db,
        actor,
        "submit_proposal",
        project,
        {"title": "Своя идея", "kind": "feature_idea", "content": {"description": "Описание идеи"}},
    )
    db.add(
        m.Notification(
            project_id=project,
            user_id=actor.user.id,
            event="proposal_decided",
            title="Own proposal",
            resource_type="proposal",
            resource_id=proposal["id"],
            created_at=m.now() - timedelta(days=1),
        )
    )
    db.flush()
    member.role = "developer"
    db.flush()
    result = dispatch(db, actor, "list_notifications", project)
    assert [n["title"] for n in result["items"]] == ["Own proposal"]
    attention = dispatch(db, actor, "get_project_attention", project)
    assert attention["unread_notifications"] == 1
    assert attention["sections"]["runs"] == attention["sections"]["cases"] == 0
    assert attention["sections"]["proposals"] == 1


def test_assigned_run_tracks_latest_attempt_not_old_failures(call, published, owner):
    run = call("create_run", title="Назначение", use_case_ids=[published["id"]])
    for item in run["items"]:
        call("assign_run_item", run_item_id=item["id"], assignee_id=owner.user.id)
    assert call("get_project_attention")["assigned_runs"] == 1
    run = approve_run(call, run)
    call("start_run", run_id=run["id"], expected_version=run["version"])
    for _ in run["items"]:
        check = call("begin_run_check", run_id=run["id"])["check"]
        call(
            "finish_run_check",
            execution_id=check["attempts"][-1]["id"],
            status="blocked",
            actual_result="Нет доступа к стенду",
        )
    assert call("get_project_attention")["assigned_runs"] == 0
    call("retry_execution", execution_id=check["attempts"][-1]["id"])
    assert call("get_project_attention")["assigned_runs"] == 1
    current = call("get_run", run_id=run["id"])
    call("cancel_run", run_id=run["id"], expected_version=current["version"], reason="Проверка завершена")
    assert call("get_project_attention")["assigned_runs"] == 0


def test_counter_is_exact_over_200_and_uses_bounded_queries(db, call, project, owner, published):
    for _ in range(250):
        db.add(
            m.Notification(
                project_id=project,
                user_id=owner.user.id,
                event="use_case_published",
                title="Публикация",
                resource_type="use_case",
                resource_id=published["id"],
            )
        )
    db.flush()
    queries = []
    connection = db.connection()

    def count(_connection, _cursor, statement, _parameters, _context, _many):
        queries.append(statement)

    event.listen(connection, "before_cursor_execute", count)
    try:
        result = call("get_project_attention")
    finally:
        event.remove(connection, "before_cursor_execute", count)
    assert result["unread_notifications"] == 250
    assert result["sections"]["cases"] == 1
    assert len(queries) <= 10
    assert len(call("list_notifications")["items"]) == 200
    call("mark_notifications_read", all_read=True)
    assert call("get_project_attention")["unread_notifications"] == 0


def test_notifications_ignore_deleted_foreign_resources_and_removed_members(db, call, project, owner):
    other = dispatch(db, owner, "create_project", arguments={"name": "Другой проект", "key": "OTHER"})
    c = dispatch(db, owner, "create_use_case", other["id"], {"content": {"title": "Чужой кейс"}})
    db.add(
        m.Notification(
            project_id=project,
            user_id=owner.user.id,
            event="use_case_published",
            title="Foreign",
            resource_type="use_case",
            resource_id=c["id"],
        )
    )
    db.add(
        m.Notification(
            project_id=project,
            user_id=owner.user.id,
            event="report_ready",
            title="Deleted",
            resource_type="report",
            resource_id=m.uid(),
        )
    )
    db.flush()
    assert call("get_project_attention")["unread_notifications"] == 0
    outsider, member = participant(db, project)
    db.delete(member)
    db.flush()
    with pytest.raises(HTTPException) as e:
        dispatch(db, outsider, "get_project_attention", project)
    assert e.value.status_code == 404
