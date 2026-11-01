"""One public entry point must lead to usable skills without exposing project data."""

import hashlib
import json
from io import BytesIO
from urllib.parse import urlsplit
from zipfile import ZipFile

from app import models as m
from app.config import settings
from app.version import VERSION


def test_public_agent_link_resolves_catalog_and_every_package(client, monkeypatch):
    monkeypatch.setattr(settings(), "public_url", "http://testserver")
    response = client.get("/ai.md")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    document = response.text
    manifest = client.get("/api/agent/manifest").json()
    assert manifest["platform_version"] == manifest["contract_version"] == VERSION
    assert manifest["mcp"]["url"] == "http://testserver/mcp/"
    assert manifest["bootstrap_url"] == "http://testserver/ai.md"
    assert manifest["manifest_url"] in document
    assert len(manifest["skills"]) == 9
    assert {"ucaselab-review-proposals", "ucaselab-apply-proposals"} <= {s["name"] for s in manifest["skills"]}
    for skill in manifest["skills"]:
        assert skill["read_url"] in document and skill["download_url"] in document
        markdown = client.get(urlsplit(skill["read_url"]).path)
        assert markdown.status_code == 200 and "name: " + skill["name"] in markdown.text
        archive = client.get(urlsplit(skill["download_url"]).path)
        assert archive.status_code == 200
        assert archive.headers["content-type"] == "application/zip"
        assert hashlib.sha256(archive.content).hexdigest() == skill["sha256"]
        assert len(archive.content) == skill["size_bytes"]
        with ZipFile(BytesIO(archive.content)) as bundle:
            assert bundle.testzip() is None
            assert bundle.read(skill["entrypoint"]).decode() == markdown.text


def test_public_onboarding_never_contains_project_or_credential_context(client, db, owner, project):
    marker = "private-project-guide-and-query-marker"
    db.get(m.Project, project).guide = marker
    db.flush()
    headers = {"Authorization": "Bearer " + marker, "X-Forwarded-Host": "attacker.example"}
    for path in ("/ai.md", "/api/agent/manifest"):
        response = client.get(path + "?project_id=" + project + "&token=" + marker, headers=headers)
        assert response.status_code == 200
        assert marker not in response.text
        assert owner.user.email not in response.text and project not in response.text
        assert "attacker.example" not in response.text
    assert client.get(f"/api/projects/{project}/ai.md").status_code == 401
    assert client.post("/api/actions/list_skills", json={}).status_code == 401
    assert client.post("/mcp/", json={}).status_code == 401


def test_public_skill_routes_only_serve_manifest_entries(client, call):
    catalog = call("list_skills")
    manifest = client.get("/api/agent/manifest").json()
    assert catalog["bootstrap_url"] == manifest["bootstrap_url"]
    assert catalog["manifest_url"] == manifest["manifest_url"]
    assert json.dumps(catalog["skills"], sort_keys=True) == json.dumps(
        [{k: v for k, v in skill.items() if k not in {"read_url", "download_url"}} for skill in manifest["skills"]],
        sort_keys=True,
    )
    name = manifest["skills"][0]["name"]
    for path in (
        "/api/agent/skills/not-a-skill/SKILL.md",
        f"/api/agent/skills/{name}/environment.env",
        f"/api/agent/skills/{name}/another-package.zip",
        f"/api/agent/skills/{name}/%2e%2e%2f.env",
    ):
        assert client.get(path).status_code == 404
