"""Business regressions for polymorphic discussions and personal activity."""

import pytest
from app import models as m
from app.operations import dispatch
from fastapi import HTTPException
from test_attention import participant


def test_discussions_targets_permissions_mentions_and_edits(db, call, project, published):
    author, _ = participant(db, project, "developer")
    stranger, _ = participant(db, project, "developer")
    proposal = dispatch(
        db,
        author,
        "submit_proposal",
        project,
        {
            "title": "Идея",
            "kind": "feature_idea",
            "content": {"description": "Описание"},
        },
    )
    spec = call("create_specification", title="Требование")
    run = call("create_run", title="Проверка", use_case_ids=[published["id"]])
    report = call("generate_report", title="Промежуточный", run_ids=[run["id"]], interim=True)
    execution = run["items"][0]["attempts"][0]
    for kind, target in [
        ("proposal", proposal),
        ("specification", spec),
        ("report", report),
        ("execution", execution),
    ]:
        thread = call("create_comment_thread", target_type=kind, target_id=target["id"], body="**Обсуждаем**")
        assert thread["target_type"] == kind and thread["target_id"] == target["id"]
        assert (
            call("list_comment_threads", target_type=kind, target_id=target["id"])["items"][0]["id"]
            == thread["id"]
        )
        call("create_comment", thread_id=thread["id"], body="Ответ")
        call("resolve_comment_thread", thread_id=thread["id"])
        assert call("get_comment_thread", thread_id=thread["id"])["resolved"]
    thread = call(
        "create_comment_thread",
        target_type="proposal",
        target_id=proposal["id"],
        body=f"@{{{stranger.user.id}}}",
    )
    assert all(
        n["resource_id"] != thread["id"]
        for n in dispatch(db, stranger, "list_notifications", project)["items"]
    )
    with pytest.raises(HTTPException):
        dispatch(db, stranger, "get_comment_thread", project, {"thread_id": thread["id"]})
    comment = thread["comments"][0]
    call("update_comment", comment_id=comment["id"], body=f"@{{{author.user.id}}}")
    notifications = dispatch(db, author, "list_notifications", project)["items"]
    assert sum(n["resource_id"] == thread["id"] for n in notifications) == 1
    call("update_comment", comment_id=comment["id"], body=f"Уточнение @{{{author.user.id}}}")
    assert dispatch(db, author, "list_notifications", project)["items"] == notifications


def test_own_activity_is_effectively_read_without_receipts(db, call, owner, project, published):
    # Includes legacy audit rows with no receipt and actions created after first reading.
    assert db.query(m.ActivityRead).count() == 0
    feed = call("list_activity")
    assert len(feed["items"]) >= 2 and all(i["read"] for i in feed["items"])
    assert feed["unread_count"] == call("get_project_attention")["unread_activity"] == 0
    assert call("list_activity", unread=True)["items"] == []
    assert call("list_activity", unread=False)["items"] == feed["items"]
    call("create_comment_thread", use_case_id=published["id"], body="Собственное действие")
    assert call("list_activity")["items"][0]["read"]
    assert call("list_activity")["unread_count"] == 0
    assert call("get_project_attention")["unread_activity"] == 0
    assert db.query(m.ActivityRead).count() == 0
    other, _ = participant(db, project)
    for _ in range(2):
        dispatch(db, other, "create_comment_thread", project,
                 {"use_case_id": published["id"], "body": "Чужое действие"})
    unread = call("list_activity", unread=True)
    assert len(unread["items"]) == unread["unread_count"] == 2
    assert call("get_project_attention")["unread_activity"] == 2
    assert all(i["actor_id"] != owner.user.id and not i["read"] for i in unread["items"])
    assert all(i["actor_id"] == owner.user.id for i in call("list_activity", unread=False)["items"])


def test_activity_read_is_personal_explicit_and_does_not_consume_future(db, call, project, published):
    other, _ = participant(db, project)
    witness, _ = participant(db, project)
    for _ in range(2):
        dispatch(db, other, "create_comment_thread", project,
                 {"use_case_id": published["id"], "body": "От другого участника"})
    witness_before = dispatch(db, witness, "list_activity", project)["unread_count"]
    first = call("list_activity", limit=1)
    assert first["items"] and first["unread_count"] >= 2
    item = first["items"][0]
    assert not item["read"] and "metadata" not in item
    call("mark_activity_read", event_ids=[item["id"]])
    call("mark_activity_read", event_ids=[item["id"]])
    assert call("list_activity")["unread_count"] == first["unread_count"] - 1
    assert dispatch(db, witness, "list_activity", project)["unread_count"] == witness_before
    dispatch(db, other, "create_comment_thread", project,
             {"use_case_id": published["id"], "body": "Новое сообщение"})
    after = call("list_activity", unread=True)
    assert after["unread_count"] == first["unread_count"]
    assert after["items"][0]["event_type"] == "discussion.created"
    next_page = call("list_activity", limit=1, before=first["next_cursor"])
    assert next_page["items"][0]["id"] != item["id"]
    assert all(i["entity_type"] == "use_case" for i in call("list_activity", entity_type="use_case")["items"])


def test_activity_hides_private_targets_and_revoked_membership(db, call, project, content):
    developer, member = participant(db, project, "developer")
    case = call("create_use_case", content=content)
    call("create_comment_thread", use_case_id=case["id"], body="Приватно")
    assert dispatch(db, developer, "list_activity", project)["items"] == []
    db.delete(member)
    db.flush()
    with pytest.raises(HTTPException):
        dispatch(db, developer, "list_activity", project)


def test_target_access_archive_draft_cross_project_and_moderation(db, call, project, published, content):
    developer, member = participant(db, project, "developer")
    spec = call("create_specification", title="Архив")
    thread = call(
        "create_comment_thread", target_type="specification", target_id=spec["id"], body="Прежний текст"
    )
    call("archive_specification", object_id=spec["id"], expected_version=spec["version"])
    assert call("get_comment_thread", thread_id=thread["id"])["comments"][0]["body"] == "Прежний текст"
    for op, args in [
        ("create_comment", {"thread_id": thread["id"], "body": "Изменение"}),
        ("update_comment", {"comment_id": thread["comments"][0]["id"], "body": "Изменение"}),
        ("resolve_comment_thread", {"thread_id": thread["id"]}),
    ]:
        with pytest.raises(HTTPException) as e:
            call(op, **args)
        assert e.value.detail["code"] == "OBJECT_ARCHIVED"
    draft = call("create_use_case", content=content)
    run = call("create_run", title="Приватный", case_source="draft", use_case_ids=[draft["id"]])
    report = call("generate_report", title="QA", run_ids=[run["id"]], interim=True)
    for kind, target in [("execution", run["items"][0]["attempts"][0]), ("report", report)]:
        thread = call(
            "create_comment_thread",
            target_type=kind,
            target_id=target["id"],
            body=f"@{{{developer.user.id}}}",
        )
        with pytest.raises(HTTPException):
            dispatch(db, developer, "get_comment_thread", project, {"thread_id": thread["id"]})
        assert all(
            n["resource_id"] != thread["id"]
            for n in dispatch(db, developer, "list_notifications", project)["items"]
        )
    foreign = dispatch(db, developer, "create_project", arguments={"name": "Другой", "key": "OTHER"})
    with pytest.raises(HTTPException):
        dispatch(
            db,
            developer,
            "create_comment_thread",
            foreign["id"],
            {"target_type": "specification", "target_id": spec["id"], "body": "Подмена"},
        )
    assert all(
        i["project_id"] != project
        for i in dispatch(db, developer, "list_activity", foreign["id"], {"all_projects": True})["items"]
        if i["event_type"].startswith("execution.")
    )
    db.delete(member)
    db.flush()
    assert dispatch(db, developer, "list_activity", foreign["id"], {"all_projects": True})["items"] == []


def test_comment_retry_and_removed_mentions_do_not_emit_notifications(db, call, owner, project, published):
    recipient, member = participant(db, project)
    args = {"use_case_id": published["id"], "body": f"**Текст** @{{{recipient.user.id}}}"}
    one = dispatch(db, owner, "create_comment_thread", project, args, idempotency_key="repeat")
    two = dispatch(db, owner, "create_comment_thread", project, args, idempotency_key="repeat")
    assert one == two
    assert len(dispatch(db, recipient, "list_notifications", project)["items"]) == 1
    db.delete(member)
    db.flush()
    call("create_comment", thread_id=one["id"], body=args["body"])
    assert db.query(m.Notification).filter_by(user_id=recipient.user.id, resource_id=one["id"]).count() == 1


def test_activity_all_projects_filters_and_secret_redaction(db, owner, project, call, content):
    second = dispatch(db, owner, "create_project", arguments={"name": "Второй", "key": "TWO"})
    other, _ = participant(db, second["id"])
    other_case = dispatch(db, other, "create_use_case", second["id"], {"content": content})
    call("create_test_account", name="Чувствительное", login="never-in-feed")
    feed = call("list_activity", all_projects=True)
    assert any(i["project_id"] == second["id"] for i in feed["items"])
    assert "never-in-feed" not in str(feed) and "Чувствительное" not in str(feed)
    filtered = call("list_activity", all_projects=True, event_type="use_case.created", actor_id=other.user.id)
    assert [i["resource_id"] for i in filtered["items"]] == [other_case["id"]]
    assert call("list_activity", since="2100-01-01T00:00:00Z")["items"] == []
    foreign_event = filtered["items"][0]["id"]
    call("mark_activity_read", event_ids=[foreign_event])
    assert not call("list_activity", all_projects=True)["items"][0]["read"]
    call("mark_activity_read", event_ids=[foreign_event], all_projects=True)
    assert call("list_activity", all_projects=True)["items"][0]["read"]


def test_concurrent_cross_project_read_receipts_are_idempotent(content):
    """Different context-project locks can race on one all-project event receipt."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from app.db import Base, engine
    from app.security import Actor
    from sqlalchemy import func, select, text
    from sqlalchemy.orm import Session

    schema = "activity_race_" + m.uid().replace("-", "")
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    isolated = engine.execution_options(schema_translate_map={None: schema})
    try:
        Base.metadata.create_all(isolated)
        with Session(isolated, expire_on_commit=False) as session:
            user = m.User(email="race@example.invalid", name="Race", verified=True, password_hash="unused")
            session.add(user)
            session.flush()
            actor = Actor(user)
            projects = [
                dispatch(session, actor, "create_project", arguments={"name": f"Race {i}", "key": f"R{i}"})[
                    "id"
                ]
                for i in range(3)
            ]
            case = dispatch(session, actor, "create_use_case", projects[0], {"content": content})
            event_id = dispatch(session, actor, "list_activity", projects[0])["items"][0]["id"]
            session.commit()
            user_id = user.id
        barrier = Barrier(2)

        def mark(context_project):
            with Session(isolated) as session:
                actor = Actor(session.get(m.User, user_id))
                barrier.wait(timeout=5)
                result = dispatch(
                    session,
                    actor,
                    "mark_activity_read",
                    context_project,
                    {"event_ids": [event_id], "all_projects": True},
                )
                session.commit()
                return result

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(mark, p) for p in projects[1:]]
            assert [f.result(timeout=10) for f in futures] == [{"ok": True}, {"ok": True}]
        with Session(isolated) as session:
            assert session.scalar(select(func.count()).select_from(m.ActivityRead)) == 1
            actor = Actor(session.get(m.User, user_id))
            other, _ = participant(session, projects[0])
            dispatch(
                session,
                other,
                "create_comment_thread",
                projects[0],
                {"use_case_id": case["id"], "body": "Событие после отметки"},
            )
            assert (
                dispatch(session, actor, "list_activity", projects[0], {"unread": True})["unread_count"] == 1
            )
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))


def test_discussion_list_has_bounded_queries_and_archive_event_filter(db, call, project, owner, published):
    from sqlalchemy import event

    for i in range(25):
        call("create_comment_thread", use_case_id=published["id"], body=f"Вопрос {i}")
    queries = []
    connection = db.connection()

    def count(_connection, _cursor, statement, _parameters, _context, _many):
        queries.append(statement)

    event.listen(connection, "before_cursor_execute", count)
    try:
        threads = call("list_comment_threads", use_case_id=published["id"])
    finally:
        event.remove(connection, "before_cursor_execute", count)
    assert len(threads["items"]) == 25
    assert all(t["comments"] for t in threads["items"])
    assert len(queries) <= 10
    call("archive_use_case", object_id=published["id"], expected_version=published["version"])
    events = call("list_activity", event_type="use_case.archived")["items"]
    assert len(events) == 1 and events[0]["resource_id"] == published["id"]


def test_saving_identical_comment_does_not_create_history_or_activity(db, call, published):
    thread = call("create_comment_thread", use_case_id=published["id"], body="**Неизменённый текст**")
    comment_id = thread["comments"][0]["id"]
    before = call("list_activity")["unread_count"]
    saved = call("update_comment", comment_id=comment_id, body="**Неизменённый текст**")
    assert saved["updated_at"] is None
    assert db.get(m.Comment, comment_id).history == []
    assert call("list_activity")["unread_count"] == before


def test_activity_does_not_disclose_unpublished_edits_to_developer(db, call, project, published):
    developer, _ = participant(db, project, "developer")
    content = {**published["content"], "goal": "Закрытое уточнение в рабочем черновике"}
    call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content=content,
    )
    assert any(i["event_type"] == "use_case.draft_saved" for i in call("list_activity")["items"])
    visible = dispatch(db, developer, "list_activity", project)["items"]
    assert {i["event_type"] for i in visible} == {"use_case.created", "use_case.published"}
