"""Lifecycle, privacy and notification regressions exercised through shared operations."""

import copy

import pytest
from app import models as m
from app.operations import dispatch
from fastapi import HTTPException
from test_attention import participant


def test_subscriptions_mute_replies_and_remain_personal(db, project, call, published):
    actor, _ = participant(db, project, "developer")
    def invoke(name, **args):
        return dispatch(db, actor, name, project, args)

    thread = invoke("create_comment_thread", use_case_id=published["id"], body="Вопрос по сценарию")
    subscription = invoke("subscribe", resource_type="thread", resource_id=thread["id"], level="muted")
    call("create_comment", thread_id=thread["id"], body="Ответ участнику")
    assert invoke("list_notifications")["items"] == []
    changed = invoke("subscribe", resource_type="thread", resource_id=thread["id"], level="all")
    assert changed["id"] == subscription["id"]
    call("create_comment", thread_id=thread["id"], body="Следующий ответ")
    assert len(invoke("list_notifications")["items"]) == 1
    with pytest.raises(HTTPException) as error:
        call("unsubscribe", subscription_id=subscription["id"])
    assert error.value.status_code == 404
    invoke("unsubscribe", subscription_id=subscription["id"])
    assert invoke("list_my_subscriptions")["items"] == []


def test_anchor_lifecycle_and_moderation_preserve_history(db, project, call, published):
    thread = call(
        "create_comment_thread",
        use_case_id=published["id"],
        body="Уточнение к первому шагу",
        anchor={
            "revision_id": published["revision_id"],
            "field_path": "steps/open",
            "step_key": "open",
            "quote": "Открыть форму",
        },
    )
    assert thread["anchor_status"] == "current"
    modified = copy.deepcopy(published["content"])
    modified["steps"] = modified["steps"][1:]
    call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content=modified,
    )
    assert call("get_comment_thread", thread_id=thread["id"])["anchor_status"] == "target_removed"
    manager, _ = participant(db, project, "manager")
    comment = thread["comments"][0]
    dispatch(
        db,
        manager,
        "moderate_comment",
        project,
        {"comment_id": comment["id"], "reason": "Неверная формулировка"},
    )
    stored = db.get(m.Comment, comment["id"])
    assert stored.deleted and stored.body == ""
    assert stored.history[-1]["body"] == "Уточнение к первому шагу"
    assert stored.history[-1]["moderator_id"] == manager.user.id
    assert call("get_comment_thread", thread_id=thread["id"])["comments"][0]["deleted"]


def test_comment_ownership_resolving_and_edit_history(db, project, call, published):
    developer, _ = participant(db, project, "developer")
    thread = call("create_comment_thread", use_case_id=published["id"], body="Ветка руководителя")
    comment = dispatch(
        db, developer, "create_comment", project, {"thread_id": thread["id"], "body": "Ответ разработчика"}
    )
    for name, args in [
        ("update_comment", {"comment_id": thread["comments"][0]["id"], "body": "Чужая правка"}),
        ("resolve_comment_thread", {"thread_id": thread["id"]}),
        ("delete_comment", {"comment_id": thread["comments"][0]["id"]}),
    ]:
        with pytest.raises(HTTPException) as e:
            dispatch(db, developer, name, project, args)
        assert e.value.status_code == 403
    updated = dispatch(
        db, developer, "update_comment", project, {"comment_id": comment["id"], "body": "Уточнённый ответ"}
    )
    assert updated["body"] == "Уточнённый ответ"
    assert db.get(m.Comment, comment["id"]).history[-1]["body"] == "Ответ разработчика"
    call("resolve_comment_thread", thread_id=thread["id"])
    assert call("list_comment_threads", use_case_id=published["id"], resolved=True)["items"][0]["resolved"]
    call("resolve_comment_thread", thread_id=thread["id"], resolved=False)
    dispatch(db, developer, "delete_comment", project, {"comment_id": comment["id"]})
    with pytest.raises(HTTPException):
        dispatch(
            db,
            developer,
            "update_comment",
            project,
            {"comment_id": comment["id"], "body": "Вернуть удалённый текст"},
        )


def test_notification_preferences_preserve_theme_and_validate_events(call, owner):
    owner.user.preferences = {**owner.user.preferences, "theme": "dark"}
    saved = call("update_notification_preferences", preferences={"email": False, "comment_reply": False})
    assert call("get_notification_preferences")["preferences"] == saved["preferences"]
    assert owner.user.preferences["theme"] == "dark"
    with pytest.raises(HTTPException) as e:
        call("update_notification_preferences", preferences={"unknown": True})
    assert e.value.detail["code"] == "INVALID_PREFERENCES"


def test_manager_cannot_modify_other_managers_or_protected_owner(db, project, call, owner):
    manager, _ = participant(db, project, "manager")
    other, other_member = participant(db, project, "manager")
    tester, tester_member = participant(db, project)
    for name, args in [
        ("update_project_member", {"member_id": other_member.id, "role": "tester"}),
        ("update_project_member", {"member_id": tester_member.id, "role": "manager"}),
        ("remove_project_member", {"member_id": other_member.id}),
    ]:
        with pytest.raises(HTTPException) as e:
            dispatch(db, manager, name, project, args)
        assert e.value.status_code == 403
    owner_member = next(x for x in call("list_project_members")["items"] if x["user_id"] == owner.user.id)
    with pytest.raises(HTTPException) as e:
        call("remove_project_member", member_id=owner_member["id"])
    assert e.value.detail["code"] == "OWNER_PROTECTED"
    dispatch(
        db, manager, "update_project_member", project, {"member_id": tester_member.id, "role": "developer"}
    )
    assert tester_member.role == "developer"
    dispatch(db, manager, "remove_project_member", project, {"member_id": tester_member.id})
    assert all(x["user_id"] != tester.user.id for x in call("list_project_members")["items"])


def test_secret_permissions_are_independent_of_metadata_access(db, project, call):
    account = call("create_test_account", name="QA", login="qa@example.invalid")
    encrypted = call(
        "set_test_account_secret",
        account_id=account["id"],
        expected_version=account["version"],
        secret="Secret-only-in-memory",
    )
    developer, member = participant(db, project, "developer")
    assert dispatch(db, developer, "get_test_account", project, {"account_id": account["id"]})["has_secret"]
    with pytest.raises(HTTPException) as e:
        dispatch(
            db,
            developer,
            "reveal_test_account_secret",
            project,
            {"account_id": account["id"], "reason": "Проверка"},
        )
    assert e.value.detail["code"] == "SECRET_ACCESS_DENIED"
    member.can_read_secrets = True
    db.flush()
    assert (
        dispatch(
            db,
            developer,
            "reveal_test_account_secret",
            project,
            {"account_id": account["id"], "reason": "Для запуска"},
        )["secret"]
        == "Secret-only-in-memory"
    )
    assert "Secret-only-in-memory" not in str(call("get_test_account", account_id=account["id"]))
    call(
        "set_test_account_secret", account_id=account["id"], expected_version=encrypted["version"], secret=""
    )
    assert not call("get_test_account", account_id=account["id"])["has_secret"]
