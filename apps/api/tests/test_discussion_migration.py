"""Exercise the actual baseline upgrade with retained legacy data in a disposable schema."""

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app import models as m
from app.db import engine
from sqlalchemy import select, text


def load(name):
    path = Path(__file__).parents[1] / "migrations" / "versions" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_baseline_upgrade_preserves_comments_notifications_and_backfills_activity():
    schema = "migration_" + m.uid().replace("-", "")
    with engine.connect() as connection, connection.begin():
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
        with Operations.context(MigrationContext.configure(connection)):
            for name in [
                "0001_initial",
                "0002_catalog",
                "0003_specification_folders",
                "0004_draft_runs_readiness",
            ]:
                load(name).upgrade()
            user, project, case, thread, comment, notification = [m.uid() for _ in range(6)]
            connection.execute(
                m.User.__table__.insert().values(
                    id=user, email="legacy@example.invalid", name="Автор", password_hash="unused"
                )
            )
            connection.execute(
                m.Project.__table__.insert().values(id=project, name="Legacy", key="OLD", owner_id=user)
            )
            connection.execute(
                m.UseCase.__table__.insert().values(
                    id=case, project_id=project, key="OLD-UC-1", title="Сценарий"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO comment_threads (id,created_at,project_id,use_case_id,author_id,anchor,visibility,resolved) VALUES (:id,now(),:project,:case,:user,NULL,'project',false)"
                ),
                {"id": thread, "project": project, "case": case, "user": user},
            )
            connection.execute(
                m.Comment.__table__.insert().values(
                    id=comment, thread_id=thread, author_id=user, body="**Прежний текст**"
                )
            )
            connection.execute(
                m.Notification.__table__.insert().values(
                    id=notification,
                    project_id=project,
                    user_id=user,
                    event="comment_reply",
                    title="Прежнее уведомление",
                    resource_type="thread",
                    resource_id=thread,
                    read=True,
                )
            )
            load("0005_discussion_activity").upgrade()
            assert connection.scalar(select(m.Thread.target_id).where(m.Thread.id == thread)) == case
            assert (
                connection.scalar(select(m.Comment.body).where(m.Comment.id == comment))
                == "**Прежний текст**"
            )
            assert (
                connection.scalar(select(m.Notification.read).where(m.Notification.id == notification))
                is True
            )
            historical = connection.execute(
                select(m.Audit.action, m.Audit.actor_id).where(m.Audit.resource_id == thread)
            ).one()
            assert historical == ("discussion.created", user)
            load("0005_discussion_activity").downgrade()
            assert (
                connection.scalar(select(m.Comment.body).where(m.Comment.id == comment))
                == "**Прежний текст**"
            )
        connection.rollback()
