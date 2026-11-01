"""Transactional SMTP outbox. Run as an independent service."""

import base64
import json
import logging
import signal
import smtplib
import time
from datetime import timedelta
from email.message import EmailMessage

from sqlalchemy import select

from . import models as m
from .config import settings
from .db import SessionLocal
from .security import decrypt

log = logging.getLogger("ucaselab.worker")
running = True


def send_email(mail):
    message = EmailMessage()
    message["From"] = settings().smtp_from
    message["To"] = mail["to"]
    message["Subject"] = mail["subject"]
    message.set_content(mail["body"])
    with smtplib.SMTP(settings().smtp_host, settings().smtp_port, timeout=20) as smtp:
        if settings().smtp_starttls:
            smtp.starttls()
        if settings().smtp_user:
            smtp.login(settings().smtp_user, settings().smtp_password)
        smtp.send_message(message)


def process_one():
    if not settings().email_enabled:
        return False
    with SessionLocal() as db:
        event = db.scalar(
            select(m.Outbox)
            .where(m.Outbox.delivered_at.is_(None), m.Outbox.available_at <= m.now(), m.Outbox.attempts < 12)
            .order_by(m.Outbox.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if not event:
            return False
        try:
            if event.kind == "email":
                mail = json.loads(decrypt(base64.urlsafe_b64decode(event.payload["encrypted"])))
                send_email(mail)
            elif event.kind == "notification_email":
                notification = db.get(m.Notification, event.payload["notification_id"])
                member = (
                    db.scalar(
                        select(m.Membership).where(
                            m.Membership.project_id == notification.project_id,
                            m.Membership.user_id == notification.user_id,
                        )
                    )
                    if notification
                    else None
                )
                project = db.get(m.Project, notification.project_id) if notification else None
                if notification and member and project and not project.archived:
                    from .notification_visibility import notification_query
                    from .operations import Context
                    from .security import Actor

                    user = db.get(m.User, notification.user_id)
                    context = Context(db, Actor(user), project, member) if user else None
                    allowed = (
                        context is not None
                        and db.scalar(notification_query(context).where(m.Notification.id == notification.id))
                        is not None
                    )
                    if (
                        allowed
                        and user
                        and user.verified
                        and user.preferences.get(project.id, {}).get("email", False)
                    ):
                        send_email(
                            {
                                "to": user.email,
                                "subject": f"Уведомление — {project.name}",
                                "body": f"В проекте есть новое уведомление.\n\n{settings().public_url}/p/{project.id}/notifications",
                            }
                        )
            event.delivered_at, event.error = m.now(), None
            # Erase delivery payload containing encrypted one-time links after SMTP accepts it.
            if event.kind == "email":
                event.payload = {"delivered": True}
        except Exception as exc:
            event.attempts += 1
            event.error = type(exc).__name__  # Never SMTP response text or message body.
            event.available_at = m.now() + timedelta(seconds=min(3600, 5 * 2**event.attempts))
            log.warning(
                "Outbox delivery failed: event=%s type=%s attempt=%s", event.id, event.error, event.attempts
            )
        db.commit()
        return True


def stop(*_):
    global running
    running = False


if __name__ == "__main__":
    settings().validate_runtime()
    logging.basicConfig(level=logging.INFO)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while running:
        try:
            if not process_one():
                time.sleep(2)
        except Exception as exc:
            log.error("Worker cycle failed: %s", type(exc).__name__)
            time.sleep(5)
