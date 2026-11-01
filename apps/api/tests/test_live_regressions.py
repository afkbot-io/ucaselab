"""Regressions reproduced on the deployed 1.9.0 application (198-variant audit)."""

import copy

import pytest
from app import models as m
from app.operations import dispatch
from fastapi import HTTPException
from sqlalchemy import func, select
from test_attention import participant


@pytest.mark.parametrize("reason", ["   ", "\t\n ", "\u2003\u00a0\u2003", " ab "])
def test_secret_requires_a_meaningful_reason_without_audit_or_disclosure(call, db, project, reason):
    account = call("create_test_account", name="QA", login="qa@example.invalid")
    call(
        "set_test_account_secret",
        account_id=account["id"],
        expected_version=account["version"],
        secret="private-fixture",
    )
    before = db.scalar(select(func.count()).select_from(m.Audit).where(m.Audit.project_id == project))
    with pytest.raises(HTTPException) as error:
        call("reveal_test_account_secret", account_id=account["id"], reason=reason)
    assert error.value.detail["code"] == "VALIDATION_ERROR"
    assert "private-fixture" not in str(error.value.detail)
    assert db.scalar(select(func.count()).select_from(m.Audit).where(m.Audit.project_id == project)) == before
    assert (
        call("reveal_test_account_secret", account_id=account["id"], reason="  Проверка входа  ")["secret"]
        == "private-fixture"
    )
    audit = db.scalar(
        select(m.Audit).where(m.Audit.project_id == project, m.Audit.action == "secret.revealed")
    )
    assert audit.metadata_["reason"] == "Проверка входа"


@pytest.mark.parametrize("role", ["tester", "manager", "owner", "developer"])
def test_moderation_role_matrix_preserves_reason_history_and_audit(call, db, project, published, owner, role):
    thread = call("create_comment_thread", use_case_id=published["id"], body="Текст для модерации")
    comment_id = thread["comments"][0]["id"]
    actor = owner if role == "owner" else participant(db, project, role)[0]
    args = {"comment_id": comment_id, "reason": "  Дублирующее обсуждение  "}
    if role == "developer":
        with pytest.raises(HTTPException) as error:
            dispatch(db, actor, "moderate_comment", project, args)
        assert error.value.status_code == 403
        assert not db.get(m.Comment, comment_id).deleted
        return
    dispatch(db, actor, "moderate_comment", project, args)
    stored = db.get(m.Comment, comment_id)
    assert stored.deleted and stored.body == ""
    assert stored.history[-1]["body"] == "Текст для модерации"
    assert stored.history[-1]["reason"] == "Дублирующее обсуждение"
    assert stored.history[-1]["moderator_id"] == actor.user.id
    audit = db.scalar(
        select(m.Audit).where(m.Audit.resource_id == comment_id, m.Audit.action == "comment.moderated")
    )
    assert audit.actor_id == actor.user.id


@pytest.mark.parametrize("keys", [[], ["missing"], ["valid", "missing"], ["valid", "valid"]])
def test_invalid_explicit_variants_cannot_activate_or_change_active_plan(call, published, keys):
    content = {
        "title": "Проверка плана",
        "items": [{"use_case_id": published["id"], "variant_selection": "explicit", "variant_keys": keys}],
    }
    # Incomplete selections may be saved as drafts, never exposed as active plans.
    draft = call("create_case_plan", content=content)
    for name, args in [
        ("create_case_plan", {}),
        ("update_case_plan", {"plan_id": draft["id"], "expected_version": draft["version"]}),
    ]:
        with pytest.raises(HTTPException) as error:
            call(name, content=content, status="active", **args)
        assert error.value.detail["code"] == "PLAN_SELECTION_STALE"
    unchanged = call("get_case_plan", plan_id=draft["id"])
    assert unchanged["status"] == "draft" and unchanged["version"] == draft["version"]
    content["items"][0]["variant_keys"] = ["valid"]
    active = call(
        "update_case_plan",
        plan_id=draft["id"],
        expected_version=draft["version"],
        content=content,
        status="active",
    )
    assert call("preview_case_plan", plan_id=active["id"])["count"] == 1


def test_active_plans_validate_pinned_publication_not_working_draft(call, published):
    changed = copy.deepcopy(published["content"])
    changed["variants"][0]["enabled"] = False
    draft = call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content=changed,
    )
    content = {
        "title": "Закреплённая публикация",
        "items": [
            {
                "use_case_id": published["id"],
                "version_policy": "fixed_publication",
                "publication_id": published["current_publication_id"],
                "variant_selection": "explicit",
                "variant_keys": ["valid"],
            }
        ],
    }
    assert call("create_case_plan", content=content, status="active")["status"] == "active"
    call(
        "publish_use_case",
        use_case_id=draft["id"],
        expected_version=draft["version"],
        revision_id=draft["revision_id"],
        message="Отключён вариант",
    )
    content["items"][0]["version_policy"] = "latest_published"
    with pytest.raises(HTTPException) as error:
        call("create_case_plan", content=content, status="active")
    assert error.value.detail["code"] == "PLAN_SELECTION_STALE"


def test_empty_active_plan_is_rejected_but_draft_can_be_saved(call):
    assert call("create_case_plan", content={"title": "Незавершённый план"})["status"] == "draft"
    with pytest.raises(HTTPException) as error:
        call("create_case_plan", content={"title": "Незавершённый план"}, status="active")
    assert error.value.detail["code"] == "INCOMPLETE_PLAN"
