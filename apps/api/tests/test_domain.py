import copy

import pytest
from app import models as m
from app.operations import dispatch
from app.security import Actor, decrypt, encrypt
from conftest import approve_run
from fastapi import HTTPException


def test_revision_history_semantic_diff_and_conflict(call, published):
    case = published
    content = copy.deepcopy(case["content"])
    content["steps"].reverse()
    content["variants"][1]["expected"] = "Красная ошибка формата почты"
    draft = call(
        "save_use_case_draft",
        use_case_id=case["id"],
        expected_version=case["version"],
        base_revision_id=case["revision_id"],
        content=content,
    )
    assert draft["has_unpublished_changes"]
    assert draft["current_publication_id"] == case["current_publication_id"]
    diff = call(
        "compare_use_case_revisions",
        use_case_id=case["id"],
        from_revision_id=case["revision_id"],
        to_revision_id=draft["revision_id"],
    )
    assert any(c["kind"] == "moved" for c in diff["changes"])
    assert any("/invalid/expected" in c["path"] for c in diff["changes"])
    with pytest.raises(HTTPException) as exc:
        call(
            "save_use_case_draft",
            use_case_id=case["id"],
            expected_version=case["version"],
            base_revision_id=case["revision_id"],
            content=content,
        )
    assert exc.value.status_code == 409
    same = call(
        "save_use_case_draft",
        use_case_id=draft["id"],
        expected_version=draft["version"],
        base_revision_id=draft["revision_id"],
        content=content,
    )
    assert same["revision_id"] == draft["revision_id"]
    old = call("get_use_case", use_case_id=case["id"], published_only=True)
    assert old["content"]["variants"][1]["expected"] == "Показана ошибка почты"


def test_project_isolation_roles_and_token_scopes(db, owner, project, call, published):
    user = m.User(email="developer@example.com", name="Разработчик", verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    member = m.Membership(project_id=project, user_id=user.id, role="developer")
    db.add(member)
    db.flush()
    actor = Actor(user)
    draft = call("create_use_case", content={"title": "Секретный черновик"})
    visible = dispatch(db, actor, "list_use_cases", project)
    assert [x["id"] for x in visible["items"]] == [published["id"]]
    with pytest.raises(HTTPException) as exc:
        dispatch(db, actor, "get_use_case", project, {"use_case_id": draft["id"]})
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        dispatch(db, actor, "create_use_case", project, {"content": {"title": "Нет прав"}})
    assert exc.value.status_code == 403
    other = dispatch(db, owner, "create_project", arguments={"name": "Другой проект", "key": "XX"})
    with pytest.raises(HTTPException) as exc:
        dispatch(db, owner, "get_use_case", other["id"], {"use_case_id": published["id"]})
    assert exc.value.status_code == 404
    token = m.ApiToken(
        user_id=owner.user.id,
        name="Read",
        token_hash="0" * 64,
        prefix="tc_",
        scopes=["projects:read"],
        project_ids=[project],
        expires_at=m.now(),
    )
    with pytest.raises(HTTPException) as exc:
        dispatch(
            db,
            Actor(owner.user, token=token),
            "create_use_case",
            project,
            {"content": {"title": "Нет scope"}},
        )
    assert exc.value.detail["code"] == "INSUFFICIENT_SCOPE"


def test_plan_pins_versions_results_are_immutable_and_report_is_snapshot(call, published):
    plan = call(
        "create_case_plan",
        content={"title": "Регрессия", "items": [{"use_case_id": published["id"]}]},
        status="active",
    )
    preview = call("preview_case_plan", plan_id=plan["id"])
    assert preview["count"] == 2
    run = call(
        "create_run",
        title="Проверка релиза",
        plan_id=plan["id"],
        expected_plan_revision_id=preview["plan_revision_id"],
        selection_hash=preview["selection_hash"],
    )
    changed = {**published["content"], "goal": "Изменённая цель"}
    case = call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content=changed,
    )
    call(
        "publish_use_case",
        use_case_id=case["id"],
        expected_version=case["version"],
        revision_id=case["revision_id"],
        message="Новая версия",
    )
    assert call("get_run", run_id=run["id"])["items"][0]["revision_id"] == published["revision_id"]
    run = approve_run(call, run)
    run = call("start_run", run_id=run["id"], expected_version=run["version"])
    for item in run["items"]:
        execution = item["attempts"][-1]
        call("start_execution", execution_id=execution["id"])
        for step in item["snapshot"]["content"]["steps"]:
            call(
                "record_step_result",
                execution_id=execution["id"],
                step_key=step["key"],
                status="passed",
                actual_result="Наблюдение совпало с ожиданием",
            )
        call(
            "record_execution_result",
            execution_id=execution["id"],
            status="passed",
            actual_result="Проверено в браузере, поведение соответствует ожиданиям",
        )
        with pytest.raises(HTTPException) as exc:
            call(
                "record_execution_result",
                execution_id=execution["id"],
                status="failed",
                actual_result="Перезапись",
            )
        assert exc.value.detail["code"] == "EXECUTION_IMMUTABLE"
    run = call("complete_run", run_id=run["id"], expected_version=run["version"])
    assert run["summary"]["pass_rate"] == 1
    report = call("generate_report", title="Результат", run_ids=[run["id"]])
    assert report["snapshot"]["runs"][0]["summary"]["selected"] == 2
    call("add_execution_annotation", execution_id=execution["id"], body="Пояснение после отчёта")
    assert call("get_report", report_id=report["id"])["snapshot"] == report["snapshot"]
    history = call("list_use_case_executions", use_case_id=published["id"])
    assert all(not e["is_current_publication"] for e in history["items"])
    with pytest.raises(HTTPException):
        call("retry_execution", execution_id=execution["id"])
    from app.report_files import render_report

    pdf, content_type = render_report(report, "pdf")
    assert pdf.startswith(b"%PDF") and content_type == "application/pdf"


def test_plan_preview_rejects_changed_selection(call, published):
    plan = call("create_case_plan", content={"title": "План", "items": [{"use_case_id": published["id"]}]})
    preview = call("preview_case_plan", plan_id=plan["id"])
    call(
        "update_case_plan",
        plan_id=plan["id"],
        expected_version=plan["version"],
        content={"title": "Новый план", "items": [{"use_case_id": published["id"]}]},
    )
    with pytest.raises(HTTPException) as exc:
        call(
            "create_run",
            title="Не должен создаться",
            plan_id=plan["id"],
            expected_plan_revision_id=preview["plan_revision_id"],
            selection_hash=preview["selection_hash"],
        )
    assert exc.value.detail["code"] == "PLAN_SELECTION_CHANGED"


def test_proposal_application_creates_draft_without_publication(call, published):
    changed = {**published["content"], "goal": "Новая цель"}
    proposal = call(
        "submit_proposal",
        title="Обновление регистрации",
        kind="update_use_case",
        content={
            "description": "Изменилось поведение",
            "items": [
                {
                    "action": "update_use_case",
                    "use_case_id": published["id"],
                    "base_revision_id": published["revision_id"],
                    "content": changed,
                }
            ],
        },
    )
    accepted = call("accept_proposal", proposal_id=proposal["id"], expected_version=proposal["version"])
    assert accepted["status"] == "accepted"
    current = call("get_use_case", use_case_id=published["id"])
    assert current["has_unpublished_changes"]
    assert current["current_publication_id"] == published["current_publication_id"]


def test_proposal_conflict_applies_no_items(call, published):
    proposal = call(
        "submit_proposal",
        title="Набор изменений",
        kind="update_use_case",
        content={
            "description": "Два пункта",
            "items": [
                {"action": "create_use_case", "content": {"title": "Не должен создаться"}},
                {
                    "action": "update_use_case",
                    "use_case_id": published["id"],
                    "base_revision_id": published["revision_id"],
                    "content": published["content"],
                },
            ],
        },
    )
    call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content={**published["content"], "goal": "Изменено другим автором"},
    )
    with pytest.raises(HTTPException) as exc:
        call("accept_proposal", proposal_id=proposal["id"], expected_version=proposal["version"])
    assert exc.value.detail["code"] == "PROPOSAL_BASE_CONFLICT"
    assert len(call("list_use_cases")["items"]) == 1


def test_secret_encryption_and_separation(call):
    account = call("create_test_account", name="Тестировщик", login="qa@example.com")
    call(
        "set_test_account_secret",
        account_id=account["id"],
        expected_version=account["version"],
        secret="actual-secret-value",
    )
    assert "secret" not in call("get_test_account", account_id=account["id"])
    assert (
        call("reveal_test_account_secret", account_id=account["id"], reason="Выполнение регистрации")[
            "secret"
        ]
        == "actual-secret-value"
    )
    encrypted = encrypt("actual-secret-value")
    assert b"actual-secret-value" not in encrypted
    assert decrypt(encrypted) == "actual-secret-value"


def test_draft_threads_are_private_and_anchors_become_outdated(call, published):
    draft = call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content={**published["content"], "goal": "Новая цель"},
    )
    thread = call(
        "create_comment_thread",
        use_case_id=draft["id"],
        body="Уточним ожидание",
        anchor={"revision_id": draft["revision_id"], "field_path": "steps/open", "step_key": "open"},
    )
    assert thread["visibility"] == "qa_team"
    content = copy.deepcopy(draft["content"])
    content["steps"] = [s for s in content["steps"] if s["key"] != "open"]
    call(
        "save_use_case_draft",
        use_case_id=draft["id"],
        expected_version=draft["version"],
        base_revision_id=draft["revision_id"],
        content=content,
    )
    assert call("get_comment_thread", thread_id=thread["id"])["anchor_status"] == "target_removed"
    comment = call("create_comment", thread_id=thread["id"], body="Ответ")
    call("delete_comment", comment_id=comment["id"])
    assert call("get_comment_thread", thread_id=thread["id"])["comments"][-1]["deleted"]


def test_manager_cannot_promote_self_to_owner(db, owner, project, call):
    user = m.User(email="manager@example.com", name="Менеджер", verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    member = m.Membership(project_id=project, user_id=user.id, role="manager")
    db.add(member)
    db.flush()
    with pytest.raises(HTTPException) as exc:
        dispatch(db, Actor(user), "transfer_project_management", project, {"new_owner_user_id": user.id})
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException):
        dispatch(
            db, Actor(user), "update_project_member", project, {"member_id": member.id, "role": "manager"}
        )


def test_idempotency_replay_and_mismatch(db, owner, project):
    a = dispatch(db, owner, "create_folder", project, {"name": "Одна папка"}, "unique-key")
    b = dispatch(db, owner, "create_folder", project, {"name": "Одна папка"}, "unique-key")
    assert a == b
    with pytest.raises(HTTPException) as exc:
        dispatch(db, owner, "create_folder", project, {"name": "Другие данные"}, "unique-key")
    assert exc.value.detail["code"] == "IDEMPOTENCY_CONFLICT"


def test_shared_account_exclusion_and_inconsistent_verdict(call, content):
    account = call("create_test_account", name="Общий аккаунт")
    content["accounts"] = [{"account_id": account["id"], "alias": "actor"}]
    case = call("create_use_case", content=content)
    case = call(
        "publish_use_case",
        use_case_id=case["id"],
        expected_version=case["version"],
        revision_id=case["revision_id"],
        message="Опубликовано",
    )
    run = call("create_run", title="Последовательный доступ", use_case_ids=[case["id"]])
    run = approve_run(call, run)
    run = call("start_run", run_id=run["id"], expected_version=run["version"])
    first, second = [i["attempts"][-1]["id"] for i in run["items"]]
    call("start_execution", execution_id=first)
    with pytest.raises(HTTPException) as exc:
        call("start_execution", execution_id=second)
    assert exc.value.detail["code"] == "ACCOUNT_BUSY"
    call(
        "record_step_result",
        execution_id=first,
        step_key="open",
        status="failed",
        actual_result="Форма не появилась",
    )
    with pytest.raises(HTTPException) as exc:
        call(
            "record_execution_result",
            execution_id=first,
            status="passed",
            actual_result="Противоречивый результат",
        )
    assert exc.value.detail["code"] == "INCONSISTENT_VERDICT"
    call("record_execution_result", execution_id=first, status="failed", actual_result="Форма не появилась")
    call("start_execution", execution_id=second)
    with pytest.raises(HTTPException) as exc:
        call("generate_report", title="Преждевременный итог", run_ids=[run["id"]])
    assert exc.value.detail["code"] == "RUN_NOT_FINAL"


def test_secret_permission_is_separate_from_role(db, project, call):
    account = call("create_test_account", name="Защищённый аккаунт")
    user = m.User(
        email="qa-without-secrets@example.com", name="Тестировщик", verified=True, password_hash="unused"
    )
    db.add(user)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=user.id, role="tester"))
    db.flush()
    with pytest.raises(HTTPException) as exc:
        dispatch(
            db,
            Actor(user),
            "reveal_test_account_secret",
            project,
            {"account_id": account["id"], "reason": "Тест прав"},
        )
    assert exc.value.detail["code"] == "SECRET_ACCESS_DENIED"


def test_published_only_never_falls_back_to_a_draft(call):
    case = call("create_use_case", content={"title": "Ещё не опубликовано"})
    with pytest.raises(HTTPException) as exc:
        call("get_use_case", use_case_id=case["id"], published_only=True)
    assert exc.value.status_code == 404


def test_case_pagination_and_database_name_limits(call):
    call("create_use_case", content={"title": "Первая функция"})
    call("create_use_case", content={"title": "Вторая функция"})
    first = call("list_use_cases", limit=1)
    second = call("list_use_cases", limit=1, offset=first["next_offset"])
    assert first["total"] == 2 and second["next_offset"] is None
    assert first["items"][0]["id"] != second["items"][0]["id"]
    with pytest.raises(HTTPException) as exc:
        call("create_folder", name="x" * 161)
    assert exc.value.status_code == 422


def test_case_content_and_folder_save_are_one_version_change(call, published):
    folder = call("create_folder", name="Доступ")
    changed = {**published["content"], "goal": "Обновлённая цель"}
    saved = call(
        "save_use_case_draft",
        use_case_id=published["id"],
        expected_version=published["version"],
        base_revision_id=published["revision_id"],
        content=changed,
        change_folder=True,
        folder_id=folder["id"],
    )
    assert saved["folder_id"] == folder["id"] and saved["version"] == published["version"] + 1
    assert saved["revision_id"] != published["revision_id"]
    moved = call(
        "save_use_case_draft",
        use_case_id=saved["id"],
        expected_version=saved["version"],
        base_revision_id=saved["revision_id"],
        content=saved["content"],
        change_folder=True,
        folder_id=None,
    )
    assert moved["folder_id"] is None and moved["revision_id"] == saved["revision_id"]


def test_typed_variant_data_round_trip(call, content):
    inputs = {"empty": "", "space": " ", "number": 0, "numeric_text": "0", "flag": False, "missing": None}
    content["variants"][0]["inputs"] = inputs
    case = call("create_use_case", content=content)
    actual = call("get_use_case", use_case_id=case["id"])["content"]["variants"][0]["inputs"]
    assert actual == inputs
    assert (
        type(actual["flag"]) is bool and type(actual["number"]) is int and type(actual["numeric_text"]) is str
    )


def test_developer_cannot_read_draft_plan(db, project, call):
    plan = call("create_case_plan", content={"title": "Закрытая подготовка", "items": []})
    user = m.User(email="plan-reader@example.com", name="Разработчик", verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=user.id, role="developer"))
    db.flush()
    actor = Actor(user)
    assert dispatch(db, actor, "list_case_plans", project)["items"] == []
    with pytest.raises(HTTPException) as exc:
        dispatch(db, actor, "get_case_plan", project, {"plan_id": plan["id"]})
    assert exc.value.status_code == 404
