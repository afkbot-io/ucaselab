import pytest
from app import models as m
from app.operations import dispatch
from app.security import Actor
from conftest import approve_run
from fastapi import HTTPException


def prepared(call, published):
    return approve_run(call, call("create_run", title="Проверка регистрации", use_case_ids=[published["id"]]))


def test_guided_run_claim_finish_and_complete(call, published):
    run = prepared(call, published)
    overview = call("get_run_overview", run_id=run["id"])
    assert overview["status"] == "draft" and overview["progress"]["finished"] == 0
    first = call("begin_run_check", run_id=run["id"])
    check = first["check"]
    execution = check["attempts"][-1]
    assert first["run"]["status"] == "running"
    assert call("begin_run_check", run_id=run["id"])["check"]["id"] == check["id"]
    with pytest.raises(HTTPException) as exc:
        call("finish_run_check", execution_id=execution["id"], status="passed", actual_result="Проверено")
    assert exc.value.detail["code"] == "STEPS_INCOMPLETE"
    assert call("get_run_check", run_item_id=check["id"])["attempts"][-1]["status"] == "running"
    steps = [
        {"step_key": s["key"], "status": "passed", "actual_result": "Наблюдение совпало"}
        for s in check["snapshot"]["content"]["steps"]
    ]
    result = call(
        "finish_run_check",
        execution_id=execution["id"],
        status="passed",
        actual_result="Подтверждение почты получено",
        step_results=steps,
    )
    assert result["run"]["progress"]["finished"] == 1
    assert result["run"]["next_action"]["kind"] == "begin_check"
    assert result["run"]["summary"]["counts"]["running"] == 0  # No implicit start of another check.
    second = call("begin_run_check", run_id=run["id"])
    result = call(
        "finish_run_check",
        execution_id=second["check"]["attempts"][-1]["id"],
        status="blocked",
        actual_result="Окружение стало недоступно",
    )
    assert result["run"]["progress"]["finished"] == 2 and result["run"]["progress"]["percent"] == 100
    assert result["run"]["summary"]["counts"]["passed"] == 1
    assert result["run"]["actions"]["can_complete"]
    closed = call("complete_run", run_id=run["id"], expected_version=result["run"]["version"])
    assert closed["status"] == "completed" and closed["summary"]["counts"]["blocked"] == 1


def test_check_pages_and_project_isolation(call, published, owner, db):
    run = prepared(call, published)
    page = call("list_run_checks", run_id=run["id"], limit=1, status="pending", search="регистрация")
    assert page["total"] == 2 and page["next_offset"] == 1
    assert "snapshot" not in page["items"][0]
    assert call("list_run_checks", run_id=run["id"], offset=1, limit=1)["next_offset"] is None
    other = dispatch(db, owner, "create_project", arguments={"name": "Другой проект", "key": "OT"})
    with pytest.raises(HTTPException) as exc:
        dispatch(db, owner, "get_run_check", other["id"], {"run_item_id": page["items"][0]["id"]})
    assert exc.value.status_code == 404


def test_claim_respects_assignee_and_only_one_own_active(call, published, project, db):
    run = prepared(call, published)
    user = m.User(email=m.uid() + "@example.com", name="Коллега", verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=user.id, role="tester"))
    db.flush()
    call("assign_run_item", run_item_id=run["items"][0]["id"], assignee_id=user.id)
    own = call("begin_run_check", run_id=run["id"])
    assert own["check"]["id"] == run["items"][1]["id"]
    with pytest.raises(HTTPException) as exc:
        call("begin_run_check", run_id=run["id"], run_item_id=run["items"][0]["id"])
    assert exc.value.detail["code"] == "ACTIVE_CHECK_EXISTS"
    colleague = dispatch(db, Actor(user), "begin_run_check", project, {"run_id": run["id"]})
    assert colleague["check"]["id"] == run["items"][0]["id"]
    with pytest.raises(HTTPException) as exc:
        call(
            "finish_run_check",
            execution_id=colleague["check"]["attempts"][-1]["id"],
            status="skipped",
            actual_result="Нельзя менять чужой результат",
        )
    assert exc.value.status_code == 409


def test_failed_step_cannot_be_passed_and_retry_keeps_history(call, published):
    run = prepared(call, published)
    result = call("begin_run_check", run_id=run["id"])
    check = result["check"]
    eid = check["attempts"][-1]["id"]
    steps = check["snapshot"]["content"]["steps"]
    with pytest.raises(HTTPException):
        call(
            "finish_run_check",
            execution_id=eid,
            status="passed",
            actual_result="Не должно сохраниться",
            step_results=[{"step_key": s["key"], "status": "failed"} for s in steps],
        )
    assert call("get_run_check", run_item_id=check["id"])["attempts"][-1]["steps"] == {}
    call(
        "finish_run_check",
        execution_id=eid,
        status="failed",
        actual_result="Форма не открылась",
        step_results=[{"step_key": steps[0]["key"], "status": "failed", "actual_result": "Ошибка 500"}],
    )
    retried = call("begin_run_check", run_id=run["id"], run_item_id=check["id"], retry=True)
    assert len(retried["check"]["attempts"]) == 2
    assert retried["check"]["attempts"][0]["status"] == "failed"
    assert retried["check"]["attempts"][1]["attempt"] == 2
    with pytest.raises(HTTPException):
        call("finish_run_check", execution_id=eid, status="passed", actual_result="Перезапись запрещена")


def test_no_available_check_does_not_start_draft(call, published, project, db):
    run = prepared(call, published)
    user = m.User(email=m.uid() + "@example.com", name="Коллега", verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=user.id, role="tester"))
    db.flush()
    for item in run["items"]:
        call("assign_run_item", run_item_id=item["id"], assignee_id=user.id)
    result = call("begin_run_check", run_id=run["id"])
    assert result["check"] is None and result["run"]["status"] == "draft"
    assert result["run"]["next_action"]["kind"] == "wait"


def test_next_action_waits_for_busy_account_and_resumes_after_release(call, content):
    account = call("create_test_account", name="Общий аккаунт")
    case = call(
        "create_use_case", content={**content, "accounts": [{"account_id": account["id"], "alias": "actor"}]}
    )
    case = call(
        "publish_use_case",
        use_case_id=case["id"],
        expected_version=case["version"],
        revision_id=case["revision_id"],
        message="Публикация",
    )
    first = call("create_run", title="Занять аккаунт", use_case_ids=[case["id"]])
    second = call("create_run", title="Дождаться аккаунта", use_case_ids=[case["id"]])
    first = approve_run(call, first)
    second = approve_run(call, second)
    busy = call("begin_run_check", run_id=first["id"])
    assert call("get_run_overview", run_id=second["id"])["next_action"]["kind"] == "wait"
    waiting = call("begin_run_check", run_id=second["id"])
    assert waiting["check"] is None and waiting["run"]["status"] == "draft"
    call(
        "finish_run_check",
        execution_id=busy["check"]["attempts"][-1]["id"],
        status="skipped",
        actual_result="Освободить аккаунт в проверке механизма резервирования",
    )
    assert call("get_run_overview", run_id=second["id"])["next_action"]["kind"] == "begin_check"
    assert call("begin_run_check", run_id=second["id"])["check"] is not None
