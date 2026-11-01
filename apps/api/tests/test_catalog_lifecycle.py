"""Catalog lifecycle and coverage history, including pagination and bounded query counts."""

import copy

import pytest
from app import models as m
from app.operations import dispatch
from conftest import approve_run
from fastapi import HTTPException
from sqlalchemy import event
from test_attention import participant


def test_case_copy_move_history_restore_and_archive_keep_publication(call, published):
    folder = call("create_folder", name="Аккаунт")
    moved = call(
        "move_use_case",
        use_case_id=published["id"],
        expected_version=published["version"],
        folder_id=folder["id"],
    )
    assert moved["folder_id"] == folder["id"]
    assert moved["current_publication_id"] == published["current_publication_id"]
    copied = call("copy_use_case", use_case_id=moved["id"], title="Независимая копия")
    assert copied["key"] != published["key"] and copied["current_publication_id"] is None
    changed = copy.deepcopy(published["content"])
    changed["goal"] = "Уточнённая цель"
    edited = call(
        "save_use_case_draft",
        use_case_id=moved["id"],
        expected_version=moved["version"],
        base_revision_id=moved["revision_id"],
        content=changed,
    )
    restored = call(
        "restore_use_case_revision",
        use_case_id=moved["id"],
        expected_version=edited["version"],
        revision_id=published["revision_id"],
    )
    assert restored["content"]["goal"] == published["content"]["goal"]
    assert len(call("list_use_case_history", use_case_id=moved["id"])["revisions"]) == 3
    archived = call("archive_use_case", object_id=copied["id"], expected_version=copied["version"])
    assert archived["archived"]
    assert call("list_use_cases", archived=True)["items"][0]["id"] == copied["id"]
    with pytest.raises(HTTPException) as error:
        call("move_use_case", use_case_id=copied["id"], expected_version=archived["version"])
    assert error.value.detail["code"] == "OBJECT_ARCHIVED"


def test_project_settings_guide_archive_restore_and_owner_transfer(db, owner, project, call):
    context = call("get_project_context")
    updated = call(
        "update_project", expected_version=context["version"], name="Новое имя", description="Описание"
    )
    assert updated["name"] == "Новое имя"
    guide = call(
        "update_project_guide",
        expected_version=updated["version"],
        content="# Правила проекта\nПроверять только тестовый стенд.",
    )
    assert call("get_project_guide")["content"].startswith("# Правила проекта")
    archived = call("archive_project", expected_version=guide["version"])
    assert archived["archived"]
    with pytest.raises(HTTPException) as error:
        call("create_use_case", content={"title": "В архиве"})
    assert error.value.detail["code"] == "PROJECT_ARCHIVED"
    restored = call("archive_project", expected_version=archived["version"], archived=False)
    assert not restored["archived"]
    _, next_member = participant(db, project, "manager")
    moved = call("transfer_project_management", new_owner_user_id=next_member.user_id)
    assert moved["ok"]
    assert db.get(m.Project, project).owner_id == next_member.user_id
    assert call("get_project_context")["role"] == "manager"
    with pytest.raises(HTTPException) as error:
        call("archive_project", expected_version=restored["version"])
    assert error.value.status_code == 403


def test_invitations_listing_revocation_and_member_removal(db, project, call):
    invitation = call("invite_project_member", email="future@example.com", role="tester", send_email=False)
    listing = call("list_project_invitations")["items"]
    assert listing[0]["id"] == invitation["id"] and "invitation_url" not in listing[0]
    call("revoke_project_invitation", invitation_id=invitation["id"])
    assert call("list_project_invitations")["items"][0]["revoked"]
    actor, member = participant(db, project, "tester")
    call("remove_project_member", member_id=member.id)
    with pytest.raises(HTTPException) as error:
        dispatch(db, actor, "get_project_context", project)
    assert error.value.status_code == 404


def test_coverage_is_bound_to_current_publication_and_queries_are_bounded(db, call, published, content):
    run = approve_run(call, call("create_run", title="Прогон покрытия", use_case_ids=[published["id"]]))
    check = call("begin_run_check", run_id=run["id"])["check"]
    result = call(
        "finish_run_check",
        execution_id=check["attempts"][-1]["id"],
        status="blocked",
        actual_result="Нет доступа к синтетическому стенду",
    )
    assert result
    other = call("begin_run_check", run_id=run["id"])["check"]
    call(
        "finish_run_check",
        execution_id=other["attempts"][-1]["id"],
        status="blocked",
        actual_result="Синтетический стенд недоступен",
    )
    coverage = call("get_coverage")["items"][0]
    assert coverage["latest_status"] == "blocked" and coverage["execution_count"] == 2
    changed = copy.deepcopy(published["content"])
    changed["goal"] = "Новая публикация"
    draft = call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content=changed,
    )
    call(
        "publish_use_case",
        use_case_id=draft["id"],
        expected_version=draft["version"],
        revision_id=draft["revision_id"],
        message="Новая версия",
    )
    assert call("get_coverage")["items"][0]["latest_status"] is None
    for index in range(20):
        c = call("create_use_case", content={**content, "title": f"Сценарий {index}"})
        call(
            "publish_use_case",
            use_case_id=c["id"],
            expected_version=c["version"],
            revision_id=c["revision_id"],
            message="Публикация",
        )
    statements = []

    def capture(*_args):
        statements.append(1)

    event.listen(db.bind, "before_cursor_execute", capture)
    try:
        page = call("get_coverage", limit=100)
    finally:
        event.remove(db.bind, "before_cursor_execute", capture)
    assert page["total"] == 21
    assert len(statements) <= 12
