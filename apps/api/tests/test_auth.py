import base64
import json

from app import models as m
from app.security import decrypt
from sqlalchemy import select


def last_link(db):
    event = db.scalar(select(m.Outbox).where(m.Outbox.kind == "email").order_by(m.Outbox.created_at.desc()))
    mail = json.loads(decrypt(base64.urlsafe_b64decode(event.payload["encrypted"])))
    import re

    return re.search(r"token=([A-Za-z0-9_-]+)", mail["body"]).group(1)


def test_registration_verification_login_csrf_and_session_revocation(client, db):
    email = f"{m.uid()}@example.com"
    r = client.post(
        "/api/auth/register", json={"email": email, "name": "Тестировщик", "password": "example-password-123"}
    )
    assert r.status_code == 202
    r = client.post("/api/auth/login", json={"email": email, "password": "example-password-123"})
    assert r.status_code == 403
    token = last_link(db)
    r = client.post("/api/auth/consume", json={"token": token})
    assert r.status_code == 200
    csrf = r.json()["csrf"]
    assert "HttpOnly" in r.headers["set-cookie"]
    assert "SameSite=lax" in r.headers["set-cookie"]
    assert client.post("/api/auth/consume", json={"token": token}).status_code == 400
    assert client.get("/api/auth/me").json()["user"]["email"] == email
    assert (
        client.post(
            "/api/actions/create_project", json={"arguments": {"name": "Нет CSRF", "key": "NO"}}
        ).status_code
        == 403
    )
    headers = {"X-CSRF-Token": csrf}
    r = client.post(
        "/api/actions/create_project", headers=headers, json={"arguments": {"name": "С CSRF", "key": "YES"}}
    )
    assert r.status_code == 200
    assert (
        client.post("/api/auth/logout", headers={**headers, "Origin": "https://evil.invalid"}).status_code
        == 403
    )
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    r = client.post("/api/auth/login", json={"email": email, "password": "wrong-password"})
    assert r.status_code == 401
    assert "password" not in r.text
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "example-password-123"}).status_code
        == 200
    )


def test_magic_link_and_reset_revoke_existing_tokens(client, db):
    email = f"{m.uid()}@example.com"
    client.post("/api/auth/register", json={"email": email, "name": "QA", "password": "initial-password-123"})
    client.post("/api/auth/consume", json={"token": last_link(db)})
    csrf = client.get("/api/auth/me").json()["csrf"]
    token = client.post(
        "/api/tokens",
        headers={"X-CSRF-Token": csrf},
        json={"name": "agent", "scopes": ["projects:read"], "project_ids": [], "expires_days": 30},
    ).json()["token"]
    assert (
        client.post("/api/actions/get_me", headers={"Authorization": f"Bearer {token}"}, json={}).status_code
        == 200
    )
    client.post("/api/auth/email", json={"email": email, "kind": "login"})
    old_login_link = last_link(db)
    client.post("/api/auth/email", json={"email": email, "kind": "reset"})
    r = client.post("/api/auth/consume", json={"token": last_link(db), "password": "new-password-1234"})
    assert r.status_code == 200
    assert client.post("/api/auth/consume", json={"token": old_login_link}).status_code == 400
    assert (
        client.post("/api/actions/get_me", headers={"Authorization": f"Bearer {token}"}, json={}).status_code
        == 401
    )
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "initial-password-123"}).status_code
        == 401
    )
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "new-password-1234"}).status_code
        == 200
    )
    client.post("/api/auth/email", json={"email": email, "kind": "login"})
    assert client.post("/api/auth/consume", json={"token": last_link(db)}).status_code == 200


def test_validation_does_not_reflect_password(client):
    r = client.post("/api/auth/register", json={"email": "bad", "name": "QA", "password": "secret"})
    assert r.status_code == 422 and "secret" not in r.text


def test_password_preserves_intentional_whitespace(client, db):
    email = f"{m.uid()}@example.com"
    password = "  chosen-password-123  "
    client.post("/api/auth/register", json={"email": email, "name": "QA", "password": password})
    client.post("/api/auth/consume", json={"token": last_link(db)})
    assert (
        client.post("/api/auth/login", json={"email": email, "password": password.strip()}).status_code == 401
    )
    assert client.post("/api/auth/login", json={"email": email, "password": password}).status_code == 200


def test_invitation_acceptance_assigns_manager_and_preserves_owner(client, db, call, project):
    email = f"manager-{m.uid()}@example.com"
    invitation = call("invite_project_member", email=email, role="manager", send_email=False)
    token = invitation["invitation_url"].split("token=")[1]
    client.post(
        "/api/auth/register", json={"email": email, "name": "Менеджер", "password": "manager-password-123"}
    )
    verified = client.post("/api/auth/consume", json={"token": last_link(db)})
    headers = {"X-CSRF-Token": verified.json()["csrf"]}
    joined = client.post("/api/auth/accept-invitation", headers=headers, json={"token": token})
    assert joined.status_code == 200
    projects = client.post("/api/actions/list_projects", headers=headers, json={}).json()["items"]
    assert next(p for p in projects if p["id"] == project)["role"] == "manager"
    env = client.post(
        "/api/actions/create_environment",
        headers=headers,
        json={"project_id": project, "arguments": {"name": "Staging"}},
    )
    assert env.status_code == 200
    forbidden = client.post(
        "/api/actions/transfer_project_management",
        headers=headers,
        json={"project_id": project, "arguments": {"new_owner_user_id": verified.json()["user"]["id"]}},
    )
    assert forbidden.status_code == 403


def test_email_disabled_registration_login_and_no_mail(client, db, monkeypatch, call):
    from app.config import settings
    from app.worker import process_one

    monkeypatch.setattr(settings(), "email_enabled", False)
    before_mail = set(db.scalars(select(m.Outbox.id)))
    before_links = set(db.scalars(select(m.AuthChallenge.id)))
    assert client.get("/api/auth/config").json() == {"email_enabled": False}
    email = f"no-mail-{m.uid()}@example.com"
    registered = client.post(
        "/api/auth/register", json={"email": email, "name": "Без почты", "password": "no-mail-password-123"}
    )
    assert registered.status_code == 202 and registered.json()["requires_verification"] is False
    user = db.scalar(select(m.User).where(m.User.email == email))
    assert user.verified
    assert set(db.scalars(select(m.Outbox.id))) == before_mail
    assert set(db.scalars(select(m.AuthChallenge.id))) == before_links
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "no-mail-password-123"}).status_code
        == 200
    )
    # Re-registering an address must not overwrite the password.
    client.post(
        "/api/auth/register", json={"email": email, "name": "Подмена", "password": "different-password-123"}
    )
    assert (
        client.post(
            "/api/auth/login", json={"email": email, "password": "different-password-123"}
        ).status_code
        == 401
    )
    for kind in ["verify", "reset", "login"]:
        denied = client.post("/api/auth/email", json={"email": email, "kind": kind})
        assert denied.status_code == 409 and denied.json()["detail"]["code"] == "EMAIL_DISABLED"
    invitation = call("invite_project_member", email="colleague@example.com", role="tester")
    assert invitation["invitation_url"]
    assert set(db.scalars(select(m.Outbox.id))) == before_mail
    assert process_one() is False


def test_two_explicit_origins_and_no_lookalike_hosts(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings(), "public_url", "https://qa.example.com")
    monkeypatch.setattr(settings(), "allowed_origins", "https://qa-secondary.example.com")
    monkeypatch.setattr(settings(), "email_enabled", False)
    for origin in ["https://qa.example.com", "https://qa-secondary.example.com"]:
        response = client.post(
            "/api/auth/register",
            headers={"Origin": origin},
            json={"email": f"{m.uid()}@example.com", "name": "QA", "password": "two-origins-password-123"},
        )
        assert response.status_code == 202
    for origin in [
        "https://evil.example",
        "https://qa-secondary.example.com.evil.example",
        "https://other.example.com",
    ]:
        response = client.post(
            "/api/auth/register",
            headers={"Origin": origin},
            json={"email": f"{m.uid()}@example.com", "name": "QA", "password": "two-origins-password-123"},
        )
        assert response.status_code == 403 and response.json()["detail"]["code"] == "INVALID_ORIGIN"


def test_profile_theme_persists_without_overwriting_name_or_project_preferences(client, db, owner, project):
    owner.user.preferences = {project: {"email": False, "proposal.created": False}}
    db.flush()
    logged_in = client.post("/api/auth/login", json={"email": owner.user.email, "password": "password-12345"})
    headers = {"X-CSRF-Token": logged_in.json()["csrf"]}
    assert client.get("/api/auth/me").json()["user"]["preferences"] == {"theme": "system"}
    for theme in ["dark", "light", "system"]:
        saved = client.patch("/api/auth/profile", headers=headers, json={"theme": theme})
        assert saved.status_code == 200
        user = client.get("/api/auth/me").json()["user"]
        assert user["preferences"] == {"theme": theme}
        assert user["name"] == "Руководитель"
        assert owner.user.preferences[project] == {"email": False, "proposal.created": False}
    client.patch("/api/auth/profile", headers=headers, json={"theme": "dark", "name": "Новое имя"})
    client.patch("/api/auth/profile", headers=headers, json={"name": "Тестировщик"})
    assert client.get("/api/auth/me").json()["user"]["preferences"]["theme"] == "dark"
    assert owner.user.name == "Тестировщик"
    client.post("/api/auth/logout", headers=headers)
    client.post("/api/auth/login", json={"email": owner.user.email, "password": "password-12345"})
    assert client.get("/api/auth/me").json()["user"]["preferences"]["theme"] == "dark"


def test_profile_theme_validation_csrf_and_token_boundary(client, owner):
    logged_in = client.post("/api/auth/login", json={"email": owner.user.email, "password": "password-12345"})
    headers = {"X-CSRF-Token": logged_in.json()["csrf"]}
    assert client.patch("/api/auth/profile", json={"theme": "dark"}).status_code == 403
    assert client.patch("/api/auth/profile", headers=headers, json={"theme": "invalid"}).status_code == 422
    assert (
        client.patch("/api/auth/profile", headers=headers, json={"theme": {"custom": "CSS"}}).status_code
        == 422
    )
    token = client.post(
        "/api/tokens",
        headers=headers,
        json={"name": "agent", "scopes": ["projects:read"], "project_ids": [], "expires_days": 1},
    ).json()["token"]
    response = client.patch(
        "/api/auth/profile", headers={"Authorization": f"Bearer {token}"}, json={"theme": "dark"}
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "BROWSER_REQUIRED"


def test_valid_reset_link_survives_unicode_password_validation(client, db, owner):
    """A password field error must not consume an otherwise valid reset link."""
    from datetime import timedelta

    from app.security import digest

    token = "synthetic-reset-link-" + m.uid()
    challenge = m.AuthChallenge(
        user_id=owner.user.id, token_hash=digest(token), kind="reset", expires_at=m.now() + timedelta(minutes=10)
    )
    db.add(challenge)
    db.flush()
    response = client.post("/api/auth/consume", json={"token": token, "password": "😀" * 5})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "VALIDATION_ERROR"
    assert "body.password" in response.json()["detail"]["message"]
    assert token not in response.text and "😀" not in response.text
    db.refresh(challenge)
    assert not challenge.used
    response = client.post("/api/auth/consume", json={"token": token, "password": "synthetic-reset-password-123"})
    assert response.status_code == 200


def test_expired_auth_links_keep_error_contract_in_both_mail_modes(client, db, owner, monkeypatch):
    """Expiry rejects each link purpose without reflecting secrets or sending mail."""
    from datetime import timedelta

    from app.config import settings
    from app.security import digest

    before_mail = set(db.scalars(select(m.Outbox.id)))
    for email_enabled in [False, True]:
        monkeypatch.setattr(settings(), "email_enabled", email_enabled)
        for kind in ["verify", "login", "reset"]:
            token = "synthetic-expired-link-" + m.uid()
            challenge = m.AuthChallenge(
                user_id=owner.user.id, token_hash=digest(token), kind=kind,
                expires_at=m.now() - timedelta(seconds=1),
            )
            db.add(challenge)
            db.flush()
            payload = {"token": token}
            if kind == "reset":
                payload["password"] = "synthetic-reset-password-123"
            response = client.post("/api/auth/consume", json=payload)
            assert response.status_code == 400
            assert response.json()["detail"]["code"] == "INVALID_LINK"
            assert token not in response.text and "synthetic-reset-password-123" not in response.text
            db.refresh(challenge)
            assert not challenge.used
    assert set(db.scalars(select(m.Outbox.id))) == before_mail
