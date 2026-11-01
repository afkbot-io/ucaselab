import pytest
from app import models as m
from app.operations import dispatch
from app.security import Actor
from fastapi import HTTPException


def test_label_dictionaries_are_independent_and_remembered(call, content):
    spec = call("create_specification", title="Почтовые требования", tags=["Почта", " почта "])
    assert spec["tags"] == ["Почта"]
    first = call(
        "create_use_case", content={**content, "tags": ["Smoke", " smoke "], "platforms": ["web", " Web "]}
    )
    assert first["content"]["tags"] == ["Smoke"]
    assert first["content"]["platforms"] == ["Web"]
    assert call("list_tags", scope="specifications")["items"] == ["Почта"]
    assert call("list_tags", scope="use_cases")["items"] == ["Smoke"]
    call(
        "save_use_case_draft",
        use_case_id=first["id"],
        expected_version=first["version"],
        base_revision_id=first["revision_id"],
        content={**first["content"], "tags": []},
    )
    assert call("list_tags", scope="use_cases", search="smo")["items"] == ["Smoke"]
    second = call("create_use_case", content={"title": "Повторное использование", "tags": ["SMOKE"]})
    assert second["content"]["tags"] == ["Smoke"]
    with pytest.raises(HTTPException) as exc:
        call("create_specification", title="Некорректный тег", tags=[" " * 2])
    assert exc.value.status_code == 400


def test_case_search_filters_and_pages_use_visible_revision(call, content, db, project):
    spec = call("create_specification", title="Авторизация", tags=["требование"])
    account = call("create_test_account", name="Покупатель")
    linked = call(
        "create_use_case",
        content={
            **content,
            "title": "Вход покупателя",
            "goal": "Проверить одноразовый код",
            "tags": ["auth"],
            "platforms": ["iOS"],
            "priority": "high",
            "specifications": [{"specification_id": spec["id"]}],
            "accounts": [{"account_id": account["id"], "alias": "actor"}],
        },
    )
    publication = call(
        "publish_use_case",
        use_case_id=linked["id"],
        expected_version=linked["version"],
        revision_id=linked["revision_id"],
        message="Публикация",
    )
    call("create_use_case", content={"title": "Форма оплаты", "tags": ["payments"], "platforms": ["Web"]})
    hidden = call("create_use_case", content={"title": "Скрытый черновик", "tags": ["qa-only"]})
    result = call(
        "list_use_cases",
        search="одноразовый покупателя",
        priority="high",
        tags=["auth"],
        platforms=["iOS"],
        specification_id=spec["id"],
        account_id=account["id"],
    )
    assert [r["id"] for r in result["items"]] == [linked["id"]]
    pages = [call("list_use_cases", limit=1, offset=i, sort="title") for i in range(3)]
    assert all(p["total"] == 3 for p in pages)
    assert len({p["items"][0]["id"] for p in pages}) == 3
    assert pages[-1]["next_offset"] is None
    assert call("list_use_cases", search="%")["total"] == 0
    call(
        "save_use_case_draft",
        use_case_id=linked["id"],
        expected_version=publication["version"],
        base_revision_id=linked["revision_id"],
        content={**linked["content"], "goal": "Секретное изменение QA", "tags": ["draft-only"]},
    )
    dev = m.User(email=m.uid() + "@example.com", name="Разработчик", verified=True, password_hash="unused")
    db.add(dev)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=dev.id, role="developer"))
    db.flush()
    actor = Actor(dev)
    assert dispatch(db, actor, "list_use_cases", project, {"search": "Секретное"})["total"] == 0
    assert dispatch(db, actor, "list_use_cases", project, {"status": "draft"})["total"] == 0
    assert (
        dispatch(db, actor, "list_use_cases", project, {"search": "одноразовый"})["items"][0]["id"]
        == linked["id"]
    )
    assert dispatch(db, actor, "list_tags", project, {"scope": "use_cases"})["items"] == ["auth"]
    assert hidden["id"] not in [
        c["id"] for c in dispatch(db, actor, "search_project", project, {"query": ""})["use_cases"]
    ]


def test_proposal_intents_do_not_create_cases_until_acceptance(call, content):
    before = call("list_use_cases")["total"]
    idea = call(
        "submit_proposal",
        title="Нужна проверка восстановления",
        kind="new_use_case",
        content={"description": "Добавить сценарий восстановления по email"},
    )
    assert idea["content"]["items"] == []
    assert call("list_use_cases")["total"] == before
    with pytest.raises(HTTPException) as exc:
        call(
            "submit_proposal",
            title="Неполная правка",
            kind="update_use_case",
            content={"description": "Уточнить шаги"},
        )
    assert exc.value.detail["code"] == "PROPOSAL_CASE_REQUIRED"
    case = call("create_use_case", content=content)
    suggestion = call(
        "submit_proposal",
        title="Уточнить сообщение",
        kind="update_use_case",
        target_use_case_id=case["id"],
        content={"description": "Показать текст ошибки"},
    )
    assert (
        call(
            "list_proposals",
            use_case_id=case["id"],
            kind="update_use_case",
            status="open",
            search="сообщение",
        )["items"][0]["id"]
        == suggestion["id"]
    )
    assert call("list_proposals", kind="new_use_case", limit=1)["total"] == 1


def test_catalogs_share_bounded_search_and_sort(call):
    for name in ["Бета", "Альфа", "Гамма"]:
        call("create_specification", title=name, description="Общее требование", tags=["spec"])
        call("create_test_account", name=name, login=name + "@example.com")
        call("create_case_plan", content={"title": name})
    for op in ["list_specifications", "list_test_accounts", "list_case_plans"]:
        first = call(op, search="", sort="title", limit=2)
        assert first["total"] == 3 and first["next_offset"] == 2
        field = "name" if op == "list_test_accounts" else "title"
        assert first["items"][0][field] == "Альфа"
        assert call(op, search="Бета")["total"] == 1
        with pytest.raises(HTTPException) as exc:
            call(op, limit=1001)
        assert exc.value.status_code == 422
    found = call("search_project", query="Бета", entities=["specifications", "plans"], limit=1)
    assert found["totals"] == {"specifications": 1, "plans": 1}
    assert found["use_cases"] == []


def test_code_reference_covers_new_intent_proposals(call, content):
    idea = call(
        "submit_proposal",
        title="Проверить выбор тегов",
        kind="new_use_case",
        content={
            "description": "Новая проверка поиска",
            "repository": "ucaselab",
            "diff_fingerprint": "abc123",
            "impact": "behavior_changed",
        },
    )
    assert call("check_change_proposals", repository="ucaselab", diff_fingerprint="abc123")[
        "proposal_ids"
    ] == [idea["id"]]
    with pytest.raises(HTTPException) as exc:
        call(
            "update_proposal",
            proposal_id=idea["id"],
            expected_version=idea["version"],
            title=idea["title"],
            content={
                "description": "Невалидный тип",
                "items": [
                    {
                        "action": "update_use_case",
                        "use_case_id": "unknown",
                        "base_revision_id": "unknown",
                        "content": content,
                    }
                ],
            },
        )
    assert exc.value.detail["code"] == "INVALID_PROPOSAL_INTENT"
