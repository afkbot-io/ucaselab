"""Regressions found during the full 1.6.1 application review."""

import base64
from http.cookies import SimpleCookie

import pytest
from app import models as m
from app.auth import create_session
from app.config import settings
from app.operations import dispatch
from app.security import Actor
from conftest import approve_run
from fastapi import HTTPException, Response


def test_low_level_result_cannot_bypass_step_validation(call, published):
    run = call("create_run", title="Проверка API результата", use_case_ids=[published["id"]])
    run = approve_run(call, run)
    check = call("begin_run_check", run_id=run["id"])["check"]
    eid = check["attempts"][-1]["id"]
    with pytest.raises(HTTPException) as exc:
        call("record_execution_result", execution_id=eid, status="passed", actual_result="Все работает")
    assert exc.value.detail["code"] == "STEPS_INCOMPLETE"
    for step in check["snapshot"]["content"]["steps"]:
        call("record_step_result", execution_id=eid, step_key=step["key"], status="passed", actual_result="Да")
    with pytest.raises(HTTPException) as exc:
        call("record_execution_result", execution_id=eid, status="passed", actual_result="   ")
    assert exc.value.detail["code"] == "RESULT_REQUIRED"
    result = call("record_execution_result", execution_id=eid, status="passed", actual_result="Все шаги проверены")
    assert result["status"] == "passed"


@pytest.mark.parametrize("override", [[], [{"key": "other", "action": "Открыть другой экран", "expected": ""}]])
def test_publish_checks_enabled_variant_overrides(call, content, override):
    content["variants"][0]["steps_override"] = override
    case = call("create_use_case", content=content)
    with pytest.raises(HTTPException) as exc:
        call("publish_use_case", use_case_id=case["id"], expected_version=case["version"], revision_id=case["revision_id"], message="Публикация")
    assert exc.value.detail["code"] == "INCOMPLETE_CASE"
    assert call("get_use_case", use_case_id=case["id"])["current_publication_id"] is None


def test_duplicate_variant_step_keys_and_blank_titles_are_rejected(call, content):
    duplicate = {"key": "same", "action": "Действие", "expected": "Результат"}
    content["variants"][0]["steps_override"] = [duplicate, duplicate]
    with pytest.raises(HTTPException) as exc:
        call("create_use_case", content=content)
    assert exc.value.detail["code"] == "VALIDATION_ERROR"
    with pytest.raises(HTTPException):
        call("create_use_case", content={"title": "   "})


def test_evidence_upload_download_limits_missing_file_and_project_isolation(client, db, owner, call, project, published, tmp_path, monkeypatch):
    monkeypatch.setattr(settings(), "storage_path", str(tmp_path))
    monkeypatch.setattr(settings(), "max_upload_mb", 1)
    response = Response()
    session = create_session(db, owner.user, response)
    cookie = SimpleCookie()
    cookie.load(response.headers["set-cookie"])
    client.cookies.set("tc_session", cookie["tc_session"].value)
    headers = {"X-CSRF-Token": session["csrf"]}
    run = call("create_run", title="Проверка файлов", use_case_ids=[published["id"]])
    run = approve_run(call, run)
    check = call("begin_run_check", run_id=run["id"])["check"]
    eid = check["attempts"][-1]["id"]
    upload = f"/api/projects/{project}/attachments/upload?execution_id={eid}"
    result = client.post(upload, headers=headers, files={"file": ("evidence.txt", b"observed evidence", "text/plain")})
    assert result.status_code == 200, result.text
    attachment = result.json()
    path = call("get_attachment_download", attachment_id=attachment["id"])["path"]
    assert client.get(path).content == b"observed evidence"
    assert client.get(path).headers["content-type"] == "application/octet-stream"
    other = dispatch(db, owner, "create_project", arguments={"name": "Другой проект", "key": "OT"})
    assert client.get(path.replace(project, other["id"])).status_code == 404
    assert client.post(upload, headers=headers, files={"file": ("big.bin", b"x" * (1024 * 1024 + 1))}).status_code == 413
    with pytest.raises(HTTPException):
        call("add_execution_evidence", execution_id=eid, filename="bad.txt", content_base64="%not-base64")
    second = call("add_execution_evidence", execution_id=eid, filename="mcp.txt", content_base64=base64.b64encode(b"MCP evidence").decode())
    assert client.get(call("get_attachment_download", attachment_id=second["id"])["path"]).content == b"MCP evidence"
    for stored in tmp_path.iterdir():
        stored.unlink()
    missing = client.get(path)
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "EVIDENCE_MISSING"


def test_thread_visibility_editing_moderation_and_notifications(db, owner, project, call, content):
    user = m.User(email=m.uid() + "@example.com", name="Разработчик", verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=user.id, role="developer"))
    db.flush()
    actor = Actor(user)
    case = call("create_use_case", content=content)
    private = call("create_comment_thread", use_case_id=case["id"], body="Обсуждение черновика")
    case = call("publish_use_case", use_case_id=case["id"], expected_version=case["version"], revision_id=case["revision_id"], message="Публикация")
    assert dispatch(db, actor, "list_comment_threads", project, {"use_case_id": case["id"]})["items"] == []
    with pytest.raises(HTTPException):
        dispatch(db, actor, "get_comment_thread", project, {"thread_id": private["id"]})
    public = dispatch(db, actor, "create_comment_thread", project, {"use_case_id": case["id"], "body": "Вопрос по публикации"})
    comment = public["comments"][0]
    updated = dispatch(db, actor, "update_comment", project, {"comment_id": comment["id"], "body": "Уточнённый вопрос"})
    assert updated["body"] == "Уточнённый вопрос"
    call("create_comment", thread_id=public["id"], body="Ответ тестировщика")
    notifications = dispatch(db, actor, "list_notifications", project)
    assert any(n["resource_id"] == public["id"] for n in notifications["items"])
    call("moderate_comment", comment_id=comment["id"], reason="Дубликат вопроса")
    thread = dispatch(db, actor, "get_comment_thread", project, {"thread_id": public["id"]})
    assert thread["comments"][0]["deleted"] is True and thread["comments"][0]["body"] == ""
    history = db.get(m.Comment, comment["id"]).history
    assert history[0]["body"] == "Вопрос по публикации" and history[-1]["body"] == "Уточнённый вопрос"


def test_waiting_mcp_auth_does_not_block_other_http_requests(client, owner, monkeypatch):
    """A locked token row must not prevent another request from completing and releasing its DB session."""
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    from threading import Event

    import app.main as main

    entered, release = Event(), Event()

    def locked_auth(*_, **__):
        entered.set()
        assert release.wait(4), "Authentication test release timed out"
        return owner

    monkeypatch.setattr(main, "authenticate", locked_auth)
    with ThreadPoolExecutor(max_workers=2) as pool:
        blocked = pool.submit(client.post, "/mcp/", json={})
        try:
            assert entered.wait(2)
            live = pool.submit(client.get, "/api/health/live")
            try:
                response = live.result(timeout=1)
            except TimeoutError:
                pytest.fail("A waiting MCP authentication blocked the event loop")
            assert response.status_code == 200 and response.json() == {"status": "ok"}
        finally:
            release.set()
        blocked.result(timeout=5)
