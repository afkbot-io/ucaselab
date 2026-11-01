"""Wire-level checks of the generated MCP catalog and mutation boundary."""

import json
from contextlib import contextmanager
from datetime import timedelta

import pytest
from app import models as m
from app.operations import REGISTRY
from app.security import SCOPES, digest
from jsonschema import Draft202012Validator


@pytest.fixture
def rpc(client, db, owner, project, monkeypatch):
    import app.main as main
    import app.mcp_server as server

    @contextmanager
    def session():
        yield db

    monkeypatch.setattr(main, "SessionLocal", session)
    monkeypatch.setattr(server, "SessionLocal", session)
    raw = "tc_wire_contract_fixture"
    token = m.ApiToken(
        user_id=owner.user.id,
        name="wire contract",
        prefix="tc_wire",
        token_hash=digest(raw),
        scopes=SCOPES,
        project_ids=[project],
        expires_at=m.now() + timedelta(days=1),
    )
    db.add(token)
    db.flush()
    meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
    }

    def invoke(name=None, arguments=None):
        method = "tools/call" if name else "tools/list"
        params = {"_meta": meta}
        if name:
            params.update(name=name, arguments=arguments or {})
        headers = {
            "Authorization": "Bearer " + raw,
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "mcp-method": method,
        }
        if name:
            headers["mcp-name"] = name
        response = client.post(
            "/mcp/", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        )
        assert response.status_code == 200, response.text
        return response.json()["result"]

    return invoke


def value(result):
    assert not result.get("isError"), result
    return json.loads(result["content"][0]["text"])


def test_draft_execution_preflight_and_scenario_issue_over_wire(rpc, project, content):
    def invoke(name, **arguments):
        return value(rpc(name, {"project_id": project, **arguments}))

    case = invoke("create_use_case", content=content)
    preview = invoke("preview_run", use_case_ids=[case["id"]], case_source="draft")
    run = invoke(
        "create_run",
        title="Проверка черновика через MCP",
        use_case_ids=[case["id"]],
        case_source="draft",
        selection_hash=preview["selection_hash"],
    )
    not_ready = rpc("begin_run_check", {"project_id": project, "run_id": run["id"]})
    assert not_ready["isError"] and "RUN_NOT_READY" in json.dumps(not_ready)
    ready = invoke(
        "confirm_run_readiness",
        run_id=run["id"],
        expected_version=run["version"],
        checks={"environment": "ready", "accounts": "not_required", "dependencies": "not_required"},
        actual_base_url="https://qa.example.test",
        notes="Изолированный тест контракта, сетевое выполнение эмулируется",
    )
    assert ready["can_start"]
    first = invoke("begin_run_check", run_id=run["id"])["check"]
    assert first["snapshot"]["case_source"] == "draft" and first["publication_id"] is None
    invoke(
        "finish_run_check",
        execution_id=first["attempts"][-1]["id"],
        status="scenario_issue",
        actual_result="Нужно уточнить ожидание первого шага",
    )
    second = invoke("begin_run_check", run_id=run["id"])["check"]
    finished = invoke(
        "finish_run_check",
        execution_id=second["attempts"][-1]["id"],
        status="blocked",
        actual_result="Нет тестового ящика",
    )
    invoke("complete_run", run_id=run["id"], expected_version=finished["run"]["version"])
    report = invoke("generate_report", title="MCP: черновик и ограничения", run_ids=[run["id"]])
    assert report["audience"] == "qa_team"
    assert report["snapshot"]["runs"][0]["summary"]["counts"]["scenario_issue"] == 1
    assert invoke("get_use_case", use_case_id=case["id"])["current_publication_id"] is None


def test_mcp_rejects_unknown_arguments(rpc):
    result = rpc("get_me", {"accidental_typo": "not silently discarded"})
    assert result.get("isError") is True


def test_mcp_validation_does_not_echo_private_inputs(rpc, project):
    marker = "private-value-that-must-not-appear-in-a-validation-error"
    result = rpc("create_folder", {"project_id": project, "name": {"password": marker}})
    assert result.get("isError") is True
    assert marker not in json.dumps(result)


def test_complete_mcp_catalog_is_valid_and_honest(rpc):
    tools = {t["name"]: t for t in rpc()["tools"]}
    assert set(tools) == set(REGISTRY)
    for name, tool in tools.items():
        schema = tool["inputSchema"]
        Draft202012Validator.check_schema(schema)
        assert schema.get("additionalProperties") is False
        op = REGISTRY[name]
        assert set(schema["properties"]) == set(op["model"].model_fields) | (
            {"project_id"} if not op["global_"] else set()
        ) | ({"idempotency_key"} if op["write"] and name != "reveal_test_account_secret" else set())
        assert tool["annotations"]["readOnlyHint"] is (not op["write"])
    assert tools["archive_project"]["annotations"]["destructiveHint"] is True
    assert tools["transfer_project_management"]["annotations"]["destructiveHint"] is True
    assert tools["create_use_case"]["annotations"]["destructiveHint"] is False


def test_mcp_idempotency_and_scope_boundaries(rpc, project):
    args = {"project_id": project, "name": "One folder", "idempotency_key": "wire-replay"}
    first = value(rpc("create_folder", args))
    second = value(rpc("create_folder", args))
    assert first["id"] == second["id"]
    conflict = rpc("create_folder", {**args, "name": "A different mutation"})
    assert conflict.get("isError") and "IDEMPOTENCY_CONFLICT" in str(conflict)
    extra = rpc("create_folder", {**args, "idempotency_key": "new-key", "actor_id": "someone-else"})
    assert extra.get("isError")
    denied = rpc("list_use_cases", {"project_id": m.uid()})
    assert denied.get("isError") and "NOT_FOUND" in str(denied)


def test_mcp_folder_branch_lifecycle_and_replayed_delete(rpc, project):
    def call(operation_name, **args):
        return value(rpc(operation_name, {"project_id": project, **args}))

    root = call("create_folder", name="Корень")
    child = call("create_folder", name="Подпапка", parent_id=root["id"])
    leaf = call("create_folder", name="Ветка", parent_id=child["id"])
    case = call("create_use_case", folder_id=child["id"], content={"title": "Сценарий"})
    renamed = call(
        "rename_folder", folder_id=child["id"], expected_version=child["version"], name="Новое имя"
    )
    assert renamed["parent_id"] == root["id"]
    cycle = rpc(
        "move_folder",
        {
            "project_id": project,
            "folder_id": root["id"],
            "expected_version": root["version"],
            "parent_id": leaf["id"],
        },
    )
    assert cycle.get("isError") and "FOLDER_CYCLE" in str(cycle)
    args = {
        "folder_id": child["id"],
        "expected_version": renamed["version"],
        "idempotency_key": "folder-delete-replay",
    }
    deleted = call("delete_folder", **args)
    assert deleted == call("delete_folder", **args)
    assert deleted["moved_use_cases"] == deleted["moved_folders"] == 1
    assert call("get_use_case", use_case_id=case["id"])["revision_id"] == case["revision_id"]
    assert call("get_folder", folder_id=leaf["id"])["parent_id"] == root["id"]
    restored = call("restore_folder", folder_id=child["id"], expected_version=deleted["version"])
    assert restored["parent_id"] is None and restored["total_use_case_count"] == 0


def test_mcp_specification_crud_linked_revision_and_folders(rpc, project):
    def invoke(operation_name, **args):
        return value(rpc(operation_name, {"project_id": project, **args}))

    parent = invoke("create_specification_folder", name="Правила")
    folder = invoke("create_specification_folder", name="Вход", parent_id=parent["id"])
    spec = invoke(
        "create_specification",
        title="Вход по почте",
        description="Исходное требование",
        folder_id=folder["id"],
        tags=["Auth"],
    )
    assert spec["folder_id"] == folder["id"] and spec["current_revision_id"]
    case = invoke(
        "create_use_case",
        content={
            "title": "Авторизация",
            "steps": [{"key": "open", "action": "Открыть форму", "expected": "Форма видна"}],
        },
    )
    linked = invoke(
        "set_use_case_specifications",
        use_case_id=case["id"],
        expected_version=case["version"],
        base_revision_id=case["revision_id"],
        specifications=[{"specification_id": spec["id"]}],
    )
    link = linked["content"]["specifications"][0]
    assert link == {"specification_id": spec["id"], "revision_id": spec["current_revision_id"]}
    updated = invoke(
        "update_specification",
        specification_id=spec["id"],
        expected_version=spec["version"],
        title="Вход по почте",
        description="Новое требование",
        tags=spec["tags"],
    )
    assert updated["folder_id"] == spec["folder_id"]
    assert updated["current_revision_id"] != spec["current_revision_id"]
    original = invoke(
        "get_specification_revision", specification_id=spec["id"], revision_id=link["revision_id"]
    )
    assert original["content"]["description"] == "Исходное требование"
    assert (
        invoke("list_specifications", folder_id=parent["id"], include_subfolders=True, search="новое")[
            "total"
        ]
        == 1
    )
    deleted = invoke(
        "delete_specification",
        specification_id=spec["id"],
        expected_version=updated["version"],
        idempotency_key="mcp-delete-spec-once",
    )
    assert deleted == invoke(
        "delete_specification",
        specification_id=spec["id"],
        expected_version=updated["version"],
        idempotency_key="mcp-delete-spec-once",
    )
    assert invoke("get_use_case", use_case_id=case["id"])["content"]["specifications"] == [link]
    assert invoke("list_specifications", archived=True)["items"][0]["id"] == spec["id"]
    restored = invoke(
        "restore_specification", specification_id=spec["id"], expected_version=deleted["version"]
    )
    assert not restored["archived"] and restored["current_revision_id"] == updated["current_revision_id"]
    moved = invoke("move_specification", specification_id=spec["id"], expected_version=restored["version"])
    assert moved["folder_id"] is None and moved["current_revision_id"] == restored["current_revision_id"]


def test_mcp_proposal_preparation_preview_and_application(rpc, project):
    def invoke(operation_name, **args):
        return value(rpc(operation_name, {"project_id": project, **args}))

    idea = invoke(
        "submit_proposal",
        title="Проверка регистрации",
        kind="new_use_case",
        content={"description": "Заполнить сценарий регистрации"},
    )
    proposal = invoke(
        "prepare_proposal",
        proposal_id=idea["id"],
        expected_version=idea["version"],
        items=[
            {
                "action": "create_use_case",
                "content": {
                    "title": "Регистрация",
                    "goal": "Создать аккаунт",
                    "steps": [{"key": "submit", "action": "Отправить форму", "expected": "Аккаунт создан"}],
                },
            }
        ],
    )
    assert invoke("list_use_cases")["total"] == 0
    assert invoke("preview_proposal", proposal_id=proposal["id"])["changes"]
    accepted = invoke(
        "accept_proposal",
        proposal_id=proposal["id"],
        expected_version=proposal["version"],
        idempotency_key="apply-prepared-once",
    )
    assert accepted == invoke(
        "accept_proposal",
        proposal_id=proposal["id"],
        expected_version=proposal["version"],
        idempotency_key="apply-prepared-once",
    )
    applied = accepted["decision"]["applied_items"][0]
    case = invoke("get_use_case", use_case_id=applied["use_case_id"])
    assert case["revision_id"] == applied["revision_id"] and case["current_publication_id"] is None
    assert invoke("list_use_cases")["total"] == 1


def test_attention_counts_are_visible_over_mcp_and_acknowledgement_keeps_pending_work(rpc, project):
    proposal = value(
        rpc(
            "submit_proposal",
            {
                "project_id": project,
                "title": "Проверить адаптив",
                "kind": "new_use_case",
                "content": {"description": "Добавить мобильные сценарии"},
            },
        )
    )
    attention = value(rpc("get_project_attention", {"project_id": project}))
    assert attention["project_id"] == project
    assert attention["pending_proposals"] == 1 and attention["sections"]["proposals"] == 1
    value(rpc("mark_notifications_read", {"project_id": project}))
    read = value(rpc("get_project_attention", {"project_id": project}))
    assert read["unread_notifications"] == 0 and read["sections"]["proposals"] == 1
    value(
        rpc(
            "reject_proposal",
            {
                "project_id": project,
                "proposal_id": proposal["id"],
                "expected_version": proposal["version"],
                "reason": "Покрыто опубликованным кейсом",
            },
        )
    )
    assert value(rpc("get_project_attention", {"project_id": project}))["pending_proposals"] == 0


@pytest.mark.parametrize(
    "name,arguments",
    [
        ("create_folder", {"name": "QA", "unexpected": "private-marker"}),
        ("create_folder", {"name": {"password": "private-marker"}}),
        ("create_use_case", {"content": {"title": "QA", "unexpected": "private-marker"}}),
        ("create_folder", {}),
    ],
)
def test_wire_validation_returns_stable_domain_envelope(rpc, project, name, arguments):
    result = rpc(name, {"project_id": project, **arguments})
    assert result["isError"] is True
    payload = result["content"][0]["text"]
    error = json.loads(payload[payload.index("{") :])
    assert error["error"]["code"] == "VALIDATION_ERROR" and error["status"] == 422
    assert "private-marker" not in payload


def test_wire_validation_missing_project_has_same_error_contract(rpc):
    result = rpc("create_folder", {"name": "QA"})
    payload = result["content"][0]["text"]
    error = json.loads(payload[payload.index("{") :])
    assert error["error"]["code"] == "VALIDATION_ERROR"
    assert error["status"] == 422 and "project_id" in error["error"]["message"]


def test_rejected_proposal_removal_over_mcp(rpc, project):
    proposal = value(
        rpc(
            "submit_proposal",
            {
                "project_id": project,
                "title": "Удаление через MCP",
                "kind": "feature_idea",
                "content": {"description": "Синтетическая идея"},
            },
        )
    )
    pid = proposal["id"]
    rejected = value(
        rpc(
            "reject_proposal",
            {"project_id": project, "proposal_id": pid, "expected_version": 1, "reason": "Дубликат"},
        )
    )
    removed = value(
        rpc(
            "delete_proposal",
            {"project_id": project, "proposal_id": pid, "expected_version": rejected["version"]},
        )
    )
    assert removed == {"id": pid, "archived": True, "version": 3}
    assert rpc("get_proposal", {"project_id": project, "proposal_id": pid})["isError"]
