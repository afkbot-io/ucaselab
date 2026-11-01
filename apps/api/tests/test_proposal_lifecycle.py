"""Proposal ownership, review history and filters must remain consistent for humans and MCP."""

import copy

import pytest
from app.operations import dispatch
from fastapi import HTTPException
from test_attention import participant


def test_author_edits_keep_history_and_reviewer_cannot_impersonate_author(db, project, call):
    author, _ = participant(db, project, "developer")
    original = dispatch(
        db,
        author,
        "submit_proposal",
        project,
        {
            "title": "Новый поиск",
            "kind": "new_use_case",
            "content": {"description": "Покрыть поиск"},
        },
    )
    with pytest.raises(HTTPException) as error:
        call(
            "update_proposal",
            proposal_id=original["id"],
            expected_version=1,
            title="Изменено руководителем",
            content={"description": "Не от автора"},
        )
    assert error.value.status_code == 403
    edited = dispatch(
        db,
        author,
        "update_proposal",
        project,
        {
            "proposal_id": original["id"],
            "expected_version": original["version"],
            "title": "Поиск без результатов",
            "content": {"description": "Описать пустую выдачу"},
        },
    )
    revisions = call("list_proposal_revisions", proposal_id=original["id"])["items"]
    assert [r["number"] for r in revisions] == [2, 1]
    assert revisions[1]["content"]["description"] == "Покрыть поиск"
    assert {r["author_id"] for r in revisions} == {author.user.id}
    with pytest.raises(HTTPException) as error:
        dispatch(
            db,
            author,
            "update_proposal",
            project,
            {
                "proposal_id": original["id"],
                "expected_version": 1,
                "title": "Старая версия",
                "content": {"description": "Конфликт"},
            },
        )
    assert error.value.status_code == 409
    rejected = call(
        "reject_proposal",
        proposal_id=edited["id"],
        expected_version=edited["version"],
        reason="Такой сценарий уже существует",
    )
    assert rejected["decision"]["reason"] == "Такой сценарий уже существует"
    assert rejected["status"] == "rejected"
    with pytest.raises(HTTPException) as error:
        dispatch(
            db,
            author,
            "update_proposal",
            project,
            {
                "proposal_id": edited["id"],
                "expected_version": rejected["version"],
                "title": "После решения",
                "content": {"description": "Нельзя"},
            },
        )
    assert error.value.detail["code"] == "PROPOSAL_CLOSED"


def test_withdraw_is_author_only_and_removes_change_coverage(db, project, call):
    author, _ = participant(db, project, "developer")
    args = {
        "title": "Изменён вход",
        "kind": "implementation_change",
        "content": {
            "description": "Новая валидация",
            "repository": "demo/app",
            "diff_fingerprint": "sha256:synthetic",
        },
    }
    proposal = dispatch(db, author, "submit_proposal", project, args)
    assert call("check_change_proposals", repository="demo/app", diff_fingerprint="sha256:synthetic")[
        "covered"
    ]
    with pytest.raises(HTTPException) as error:
        call("withdraw_proposal", proposal_id=proposal["id"], expected_version=1)
    assert error.value.status_code == 403
    withdrawn = dispatch(
        db,
        author,
        "withdraw_proposal",
        project,
        {
            "proposal_id": proposal["id"],
            "expected_version": proposal["version"],
        },
    )
    assert withdrawn["status"] == "withdrawn"
    assert not call("check_change_proposals", repository="demo/app", diff_fingerprint="sha256:synthetic")[
        "covered"
    ]
    for operation in ["accept_proposal", "reject_proposal"]:
        with pytest.raises(HTTPException) as error:
            call(
                operation,
                proposal_id=proposal["id"],
                expected_version=withdrawn["version"],
                reason="Повторно",
            )
        assert error.value.detail["code"] == "PROPOSAL_CLOSED"


def test_proposal_filters_pages_and_foreign_authors_are_private(db, project, call, published):
    first, _ = participant(db, project, "developer")
    second, _ = participant(db, project, "developer")
    created = []
    for actor, title in [(first, "Вход А"), (first, "Вход Б"), (second, "Вход В")]:
        created.append(
            dispatch(
                db,
                actor,
                "submit_proposal",
                project,
                {
                    "title": title,
                    "kind": "update_use_case",
                    "target_use_case_id": published["id"],
                    "content": {"description": "Уточнить сообщения формы"},
                },
            )
        )
    listing = call(
        "list_proposals",
        use_case_id=published["id"],
        kind="update_use_case",
        author_id=first.user.id,
        search="сообщения",
        sort="title",
        limit=1,
    )
    assert listing["total"] == 2 and listing["next_offset"] == 1
    assert listing["items"][0]["title"] == "Вход А"
    assert (
        call("list_proposals", author_id=first.user.id, offset=1, limit=1, sort="title")["items"][0]["title"]
        == "Вход Б"
    )
    assert dispatch(db, first, "list_proposals", project, {"author_id": second.user.id})["total"] == 0
    for operation in ["get_proposal", "list_proposal_revisions"]:
        with pytest.raises(HTTPException) as error:
            dispatch(db, first, operation, project, {"proposal_id": created[2]["id"]})
        assert error.value.status_code == 404


def test_invalid_change_references_and_duplicate_targets_are_rejected(call, published):
    for content, code in [
        ({"description": "Изменение", "repository": "demo/app"}, "CHANGE_REFERENCE_REQUIRED"),
        ({"description": "Изменение", "repository": "demo/app", "commit_sha": "short"}, "INVALID_COMMIT_SHA"),
        (
            {
                "description": "Изменение",
                "repository": "demo/app",
                "commit_sha": "a" * 40,
                "pull_request_url": "javascript:alert(1)",
            },
            "INVALID_URL",
        ),
    ]:
        with pytest.raises(HTTPException) as error:
            call("submit_proposal", title="Изменение", kind="implementation_change", content=content)
        assert error.value.detail["code"] == code
    item = {
        "action": "update_use_case",
        "use_case_id": published["id"],
        "base_revision_id": published["revision_id"],
        "content": copy.deepcopy(published["content"]),
    }
    with pytest.raises(HTTPException) as error:
        call(
            "submit_proposal",
            title="Две правки",
            kind="update_use_case",
            content={"description": "Один кейс дважды", "items": [item, item]},
        )
    assert error.value.detail["code"] == "DUPLICATE_TARGET"
