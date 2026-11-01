"""SMTP outbox delivery, privacy and permission changes without a live mail server."""

import base64
import json
from contextlib import contextmanager
from datetime import timedelta

from app import models as m
from app import worker
from app.config import settings
from app.security import encrypt
from sqlalchemy import select, update


def setup_worker(db, monkeypatch):
    @contextmanager
    def session():
        yield db

    monkeypatch.setattr(worker, "SessionLocal", session)
    monkeypatch.setattr(settings(), "email_enabled", True)
    # Existing local mail is outside this fixture; defer it only inside the rolled-back transaction.
    db.execute(update(m.Outbox).values(available_at=m.now() + timedelta(days=1)))
    sent = []
    monkeypatch.setattr(worker, "send_email", sent.append)
    return sent


def test_mail_delivery_erases_payload_and_disabled_mode_sends_nothing(db, monkeypatch):
    sent = setup_worker(db, monkeypatch)
    mail = {"to": "qa@example.com", "subject": "Подтверждение", "body": "Private one-time link"}
    event = m.Outbox(
        kind="email", payload={"encrypted": base64.urlsafe_b64encode(encrypt(json.dumps(mail))).decode()}
    )
    db.add(event)
    db.flush()
    monkeypatch.setattr(settings(), "email_enabled", False)
    assert worker.process_one() is False and not sent and event.delivered_at is None
    monkeypatch.setattr(settings(), "email_enabled", True)
    assert worker.process_one() is True and sent == [mail]
    assert event.delivered_at and event.payload == {"delivered": True}


def test_mail_failure_is_retried_without_private_exception_text(db, monkeypatch):
    setup_worker(db, monkeypatch)
    event = m.Outbox(
        kind="email",
        payload={
            "encrypted": base64.urlsafe_b64encode(encrypt(json.dumps({"to": "qa@example.com"}))).decode()
        },
    )
    db.add(event)
    db.flush()

    def fail_delivery(_):
        raise RuntimeError("private password in SMTP response")

    monkeypatch.setattr(worker, "send_email", fail_delivery)
    assert worker.process_one() is True
    assert event.attempts == 1 and event.error == "RuntimeError" and event.delivered_at is None
    assert event.available_at > m.now() and worker.process_one() is False


def test_notification_mail_rechecks_role_before_delivering(db, monkeypatch, owner, call, project, content):
    sent = setup_worker(db, monkeypatch)
    user = m.User(
        email=m.uid() + "@example.com",
        name="Бывший QA",
        password_hash="unused",
        verified=True,
        preferences={project: {"email": True}},
    )
    db.add(user)
    db.flush()
    member = m.Membership(project_id=project, user_id=user.id, role="tester")
    db.add(member)
    db.flush()
    case = call("create_use_case", content=content)
    thread = call("create_comment_thread", use_case_id=case["id"], body="Закрытое обсуждение черновика")
    notification = m.Notification(
        project_id=project,
        user_id=user.id,
        event="comment_reply",
        title="Приватное название",
        resource_type="thread",
        resource_id=thread["id"],
    )
    db.add(notification)
    db.flush()
    db.add(m.Outbox(kind="notification_email", payload={"notification_id": notification.id}))
    db.flush()
    member.role = "developer"
    assert worker.process_one() is True and not sent
    assert db.scalar(
        select(m.Outbox).where(m.Outbox.payload["notification_id"].as_string() == notification.id)
    ).delivered_at


def test_smtp_sender_supports_starttls_auth_and_unicode_without_real_network(monkeypatch):
    calls = []

    class SMTP:
        def __init__(self, host, port, timeout):
            calls.append((host, port, timeout))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def starttls(self):
            calls.append("starttls")

        def login(self, user, password):
            calls.append(("login", user, password))

        def send_message(self, message):
            calls.append(message)

    monkeypatch.setattr(worker.smtplib, "SMTP", SMTP)
    monkeypatch.setattr(settings(), "smtp_starttls", True)
    monkeypatch.setattr(settings(), "smtp_user", "synthetic-user")
    monkeypatch.setattr(settings(), "smtp_password", "synthetic-password")
    worker.send_email(
        {"to": "recipient@example.invalid", "subject": "Проверка письма", "body": "Текст сообщения"}
    )
    assert calls[1] == "starttls" and calls[2] == ("login", "synthetic-user", "synthetic-password")
    assert str(calls[-1]["Subject"]) == "Проверка письма"
    assert calls[-1].get_content().strip() == "Текст сообщения"


def test_notification_mail_does_not_deliver_draft_run_after_role_downgrade(
    db, monkeypatch, owner, call, project, content
):
    sent = setup_worker(db, monkeypatch)
    user = m.User(
        email=m.uid() + "@example.com",
        name="QA",
        verified=True,
        password_hash="unused",
        preferences={project: {"email": True}},
    )
    db.add(user)
    db.flush()
    member = m.Membership(project_id=project, user_id=user.id, role="tester")
    db.add(member)
    db.flush()
    case = call("create_use_case", content=content)
    run = call("create_run", title="QA run", use_case_ids=[case["id"]], case_source="draft")
    n = m.Notification(
        project_id=project,
        user_id=user.id,
        event="assignment",
        title="Private run",
        resource_type="run",
        resource_id=run["id"],
    )
    db.add(n)
    db.flush()
    db.add(m.Outbox(kind="notification_email", payload={"notification_id": n.id}))
    db.flush()
    member.role = "developer"
    db.flush()
    assert worker.process_one() is True and sent == []
