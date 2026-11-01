"""Draft execution is a real pinned history, with explicit preflight and distinct outcomes."""

import base64
import json
from datetime import timedelta

import pytest
from app import models as m
from app.operations import dispatch
from app.report_files import render_report
from app.security import Actor, digest
from conftest import approve_run
from fastapi import HTTPException


def test_draft_selection_is_pinned_and_never_publishes(call, content):
    case = call("create_use_case", content=content)
    with pytest.raises(HTTPException):
        call("create_run", title="Публикации", use_case_ids=[case["id"]])
    preview = call("preview_run", use_case_ids=[case["id"]], case_source="draft")
    assert "snapshot" not in preview["items"][0] and "content" not in preview["items"][0]
    run = call(
        "create_run",
        title="Черновики",
        use_case_ids=[case["id"]],
        case_source="draft",
        selection_hash=preview["selection_hash"],
    )
    assert run["case_source"] == "draft" and run["summary"]["selected"] == 2
    assert run["items"][0]["publication_id"] is None
    assert run["items"][0]["revision_id"] == case["revision_id"]
    assert run["items"][0]["snapshot"]["revision_number"] == 1
    changed = call(
        "save_use_case_draft",
        use_case_id=case["id"],
        expected_version=case["version"],
        base_revision_id=case["revision_id"],
        content={**content, "goal": "Обновлённая цель"},
    )
    assert changed["current_publication_id"] is None
    assert call("get_run", run_id=run["id"])["items"][0]["snapshot"]["content"]["goal"] == content["goal"]
    with pytest.raises(HTTPException) as exc:
        call(
            "create_run",
            title="Устаревший выбор",
            use_case_ids=[case["id"]],
            case_source="draft",
            selection_hash=preview["selection_hash"],
        )
    assert exc.value.detail["code"] == "RUN_SELECTION_CHANGED"


def test_preflight_guards_both_start_paths_and_preserves_observations(call, published):
    run = call("create_run", title="Подготовка", use_case_ids=[published["id"]])
    overview = call("get_run_overview", run_id=run["id"])
    assert overview["next_action"]["kind"] == "prepare_run" and not overview["actions"]["can_begin"]
    for operation, args in [("start_run", {"expected_version": run["version"]}), ("begin_run_check", {})]:
        with pytest.raises(HTTPException) as exc:
            call(operation, run_id=run["id"], **args)
        assert exc.value.detail["code"] == "RUN_NOT_READY"
    blocked = call(
        "confirm_run_readiness",
        run_id=run["id"],
        expected_version=run["version"],
        checks={"environment": "blocked", "accounts": "not_required", "dependencies": "not_required"},
        notes="Стенд недоступен",
    )
    assert not blocked["can_start"] and blocked["assessment"]["notes"] == "Стенд недоступен"
    with pytest.raises(HTTPException) as exc:
        call(
            "confirm_run_readiness",
            run_id=run["id"],
            expected_version=blocked["run_version"],
            checks={"environment": "blocked"},
            allow_partial=True,
        )
    assert exc.value.detail["code"] == "READINESS_REASON_REQUIRED"
    partial = call(
        "confirm_run_readiness",
        run_id=run["id"],
        expected_version=blocked["run_version"],
        checks={"environment": "blocked", "accounts": "blocked", "dependencies": "not_checked"},
        allow_partial=True,
        notes="Зафиксировать причины недоступности; успешных проверок нет",
    )
    assert partial["can_start"] and not partial["ready"]
    assert call("begin_run_check", run_id=run["id"])["check"] is not None
    with pytest.raises(HTTPException):
        call(
            "confirm_run_readiness",
            run_id=run["id"],
            expected_version=partial["run_version"] + 1,
            checks={"environment": "ready"},
        )


def test_readiness_target_override_is_local_and_account_change_invalidates_it(call, content, db):
    env = call("create_environment", name="Dev", base_url="https://wrong.example.test")
    account = call(
        "create_test_account", name="Тестовый", login="tester@example.test", environment_id=env["id"]
    )
    call(
        "set_test_account_secret",
        account_id=account["id"],
        expected_version=account["version"],
        secret="do-not-export-this-secret",
    )
    case = call(
        "create_use_case", content={**content, "accounts": [{"account_id": account["id"], "alias": "actor"}]}
    )
    run = call(
        "create_run",
        title="Проверка доступа",
        use_case_ids=[case["id"]],
        case_source="draft",
        environment_id=env["id"],
    )
    check = call(
        "confirm_run_readiness",
        run_id=run["id"],
        expected_version=run["version"],
        checks={"environment": "ready", "accounts": "ready", "dependencies": "not_required"},
        actual_base_url="https://dev.example.test",
        notes="Открыт стенд, аккаунт доступен",
    )
    assert check["ready"] and check["accounts"][0]["has_secret"]
    assert "do-not-export-this-secret" not in json.dumps(check)
    assert call("list_environments")["items"][0]["base_url"] == "https://wrong.example.test"
    assert call("get_run", run_id=run["id"])["environment"]["base_url"] == "https://dev.example.test"
    db.get(m.TestAccount, account["id"]).version += 1
    db.flush()
    assert not call("get_run_readiness", run_id=run["id"])["confirmed"]
    with pytest.raises(HTTPException) as exc:
        call("begin_run_check", run_id=run["id"])
    assert exc.value.detail["code"] == "RUN_NOT_READY"


@pytest.mark.parametrize(
    "target",
    [
        "https://user:password@example.test",
        "https://example.test/?token=private",
        "https://example.test/#private",
        "https://[bad",
        "file:///tmp/test",
    ],
)
def test_readiness_rejects_sensitive_or_invalid_target_urls(call, published, target):
    run = call("create_run", title="Адрес", use_case_ids=[published["id"]])
    with pytest.raises(HTTPException) as exc:
        call(
            "confirm_run_readiness",
            run_id=run["id"],
            expected_version=run["version"],
            checks={"environment": "ready"},
            actual_base_url=target,
        )
    assert exc.value.detail["code"] == "INVALID_URL"
    assert call("get_run", run_id=run["id"])["environment"] == {}


def test_draft_results_private_and_scenario_issues_not_product_failures(
    call, content, db, project, client, owner
):
    case = call("create_use_case", content=content)
    run = approve_run(
        call, call("create_run", title="Рецензия черновика", use_case_ids=[case["id"]], case_source="draft")
    )
    first = call("begin_run_check", run_id=run["id"])["check"]
    execution = first["attempts"][-1]
    attachment = call(
        "add_execution_evidence",
        execution_id=execution["id"],
        filename="observation.txt",
        content_base64=base64.b64encode(b"Synthetic observation").decode(),
    )
    call(
        "finish_run_check",
        execution_id=execution["id"],
        status="scenario_issue",
        actual_result="Тип выбран по умолчанию, а сценарий требует отсутствия выбора",
        step_results=[
            {
                "step_key": "open",
                "status": "scenario_issue",
                "actual_result": "Нужно уточнить начальное состояние",
            }
        ],
    )
    second = call("begin_run_check", run_id=run["id"])["check"]
    result = call(
        "finish_run_check",
        execution_id=second["attempts"][-1]["id"],
        status="blocked",
        actual_result="Нет тестового почтового ящика",
    )
    assert result["run"]["progress"]["percent"] == 100
    assert result["run"]["summary"]["counts"]["failed"] == 0
    assert result["run"]["summary"]["counts"]["scenario_issue"] == 1
    assert result["run"]["summary"]["coverage"] == 0
    assert result["run"]["summary"]["pass_rate"] is None
    call("complete_run", run_id=run["id"], expected_version=result["run"]["version"])
    report = call("generate_report", title="Черновики", run_ids=[run["id"]], audience="project")
    assert report["audience"] == "qa_team"
    assert report["snapshot"]["runs"][0]["readiness"]["checked_at"]
    csv, _ = render_report(report, "csv")
    assert "scenario_issue" in csv.decode() and "revision_id" in csv.decode()
    pdf, _ = render_report(report, "pdf")
    assert pdf.startswith(b"%PDF")
    dev = m.User(email=m.uid() + "@example.test", name="Разработчик", verified=True, password_hash="unused")
    db.add(dev)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=dev.id, role="developer"))
    db.flush()

    def bearer(user, marker):
        raw = "tc_draft_attachment_" + marker
        db.add(
            m.ApiToken(
                user_id=user.id,
                name="Fixture",
                prefix="tc_test",
                token_hash=digest(raw),
                scopes=["projects:read"],
                project_ids=[project],
                expires_at=m.now() + timedelta(days=1),
            )
        )
        db.flush()
        return {"Authorization": "Bearer " + raw}

    download_path = f"/api/projects/{project}/attachments/{attachment['id']}"
    assert client.get(download_path, headers=bearer(owner.user, "owner")).status_code == 200
    assert client.get(download_path, headers=bearer(dev, "developer")).status_code == 404
    actor = Actor(dev)

    def read(name, **args):
        return dispatch(db, actor, name, project, args)

    assert read("list_runs")["total"] == 0
    assert read("list_use_case_executions", use_case_id=case["id"])["items"] == []
    assert read("list_reports")["total"] == 0
    for name, args in [
        ("get_run", {"run_id": run["id"]}),
        ("get_run_check", {"run_item_id": first["id"]}),
        ("get_execution_bundle", {"execution_id": execution["id"]}),
        ("get_report", {"report_id": report["id"]}),
        ("get_attachment_download", {"attachment_id": attachment["id"]}),
    ]:
        with pytest.raises(HTTPException) as exc:
            read(name, **args)
        assert exc.value.status_code == 404


def test_empty_draft_override_cannot_produce_vacuous_success(call, content):
    content["variants"][0]["steps_override"] = []
    case = call("create_use_case", content=content)
    run = approve_run(
        call, call("create_run", title="Неполный черновик", use_case_ids=[case["id"]], case_source="draft")
    )
    check = call("begin_run_check", run_id=run["id"])["check"]
    eid = check["attempts"][-1]["id"]
    with pytest.raises(HTTPException) as exc:
        call("finish_run_check", execution_id=eid, status="passed", actual_result="Ложный успех")
    assert exc.value.detail["code"] == "INCOMPLETE_CASE"
    assert call("get_run_check", run_item_id=check["id"])["attempts"][-1]["status"] == "running"
    call(
        "finish_run_check",
        execution_id=eid,
        status="scenario_issue",
        actual_result="Вариант не содержит шагов",
    )


def test_preexisting_run_is_not_retroactively_blocked(call, published, db):
    run = call("create_run", title="Исторический прогон", use_case_ids=[published["id"]])
    db.get(m.Run, run["id"]).readiness = {}
    db.flush()
    assert call("get_run_readiness", run_id=run["id"])["legacy"]
    assert call("begin_run_check", run_id=run["id"])["run"]["status"] == "running"


def test_compact_creation_and_source_filters(call, published):
    draft = call(
        "create_run", title="Черновик", use_case_ids=[published["id"]], case_source="draft", compact=True
    )
    assert draft["summary"]["selected"] == 2 and "items" not in draft
    assert draft["next_action"]["kind"] == "prepare_run"
    call("create_run", title="Публикация", use_case_ids=[published["id"]], compact=True)
    assert call("list_runs", case_source="draft")["total"] == 1
    assert call("list_runs", case_source="published")["total"] == 1
