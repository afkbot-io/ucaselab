from contextlib import contextmanager
from datetime import timedelta

from app import models as m
from app.security import digest


def test_mcp_schema_authorization_and_revocation(client, db, owner, project, monkeypatch):
    import app.main as main
    import app.mcp_server as server

    @contextmanager
    def scoped_session():
        yield db

    monkeypatch.setattr(main, "SessionLocal", scoped_session)
    monkeypatch.setattr(server, "SessionLocal", scoped_session)
    raw = "tc_test_mcp_token_1234567890"
    token = m.ApiToken(
        user_id=owner.user.id,
        name="MCP integration",
        token_hash=digest(raw),
        prefix="tc_test",
        scopes=["projects:read"],
        project_ids=[project],
        expires_at=m.now() + timedelta(days=1),
    )
    db.add(token)
    db.flush()
    headers = {
        "Authorization": "Bearer " + raw,
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "mcp-method": "tools/list",
    }
    assert client.post("/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401
    meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
    }
    r = client.post(
        "/mcp/",
        headers=headers,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {"_meta": meta}},
    )
    assert r.status_code == 200, r.text
    tools = r.json()["result"]["tools"]
    create = next(t for t in tools if t["name"] == "create_use_case")
    assert "content" in create["inputSchema"]["properties"]
    assert "project_id" in create["inputSchema"]["properties"]
    r = client.post(
        "/mcp/",
        headers={**headers, "mcp-method": "tools/call", "mcp-name": "list_projects"},
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"_meta": meta, "name": "list_projects", "arguments": {}},
        },
    )
    assert r.status_code == 200, r.text
    assert project in r.text
    denied = client.post(
        "/mcp/",
        headers={**headers, "mcp-method": "tools/call", "mcp-name": "create_folder"},
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "_meta": meta,
                "name": "create_folder",
                "arguments": {"project_id": project, "name": "Denied"},
            },
        },
    )
    assert denied.json()["result"]["isError"] is True
    assert "INSUFFICIENT_SCOPE" in denied.text
    token.revoked = True
    db.flush()
    rejected = client.post("/mcp/", headers=headers, json={"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
    assert rejected.status_code == 401
    assert rejected.headers["www-authenticate"] == "Bearer"
    assert rejected.headers["cache-control"] == "no-store"
    # The official SDK parses a JSON-RPC error even on non-2xx responses.
    from mcp.types import JSONRPCError

    error = JSONRPCError.model_validate(rejected.json())
    assert error.error.message == "UNAUTHENTICATED"
    assert error.error.data["code"] == "UNAUTHENTICATED"
    assert error.error.code == -32001
    assert raw not in rejected.text


def test_official_sdk_receives_auth_and_validation_codes(client, db, owner, project, monkeypatch):
    """Exercise the SDK transport parser, not just a raw HTTP status assertion."""
    import asyncio
    import json

    import app.main as main
    import app.mcp_server as server
    import httpx2
    from app.main import app
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    from mcp.shared.exceptions import MCPError

    @contextmanager
    def scoped_session():
        yield db

    monkeypatch.setattr(main, "SessionLocal", scoped_session)
    monkeypatch.setattr(server, "SessionLocal", scoped_session)
    raw = "tc_sdk_regression_fixture"
    token = m.ApiToken(
        user_id=owner.user.id,
        name="SDK regression",
        token_hash=digest(raw),
        prefix="tc_sdk",
        scopes=["projects:read", "use_cases:write"],
        project_ids=[project],
        expires_at=m.now() + timedelta(days=1),
    )
    db.add(token)
    db.flush()

    async def scenario():
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), headers={"Authorization": "Bearer " + raw}
        ) as http:
            async with streamable_http_client("http://testserver/mcp/", http_client=http) as streams:
                async with ClientSession(*streams) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        "create_folder", {"project_id": project, "name": "QA", "unexpected": "private-marker"}
                    )
                    assert result.is_error
                    payload = result.content[0].text
                    assert "private-marker" not in payload
                    assert json.loads(payload[payload.index("{") :])["error"]["code"] == "VALIDATION_ERROR"
                    token.revoked = True
                    db.flush()
                    try:
                        await session.call_tool("get_me", {})
                    except MCPError as error:
                        assert error.error.code == -32001
                        assert error.error.message == "UNAUTHENTICATED"
                        assert error.error.data["code"] == "UNAUTHENTICATED"
                    else:
                        raise AssertionError("A revoked token was accepted")

    asyncio.run(scenario())
