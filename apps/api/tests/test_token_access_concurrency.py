"""Real PostgreSQL transactions serialize browser edits and bearer auto-grants."""

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from queue import Queue

import pytest
from app import models as m
from app.db import Base, engine
from app.main import Command, TokenAccessUpdate, action, update_token_access
from app.operations import dispatch
from app.security import Actor, digest
from fastapi import HTTPException
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from starlette.requests import Request


def request(method, headers):
    return Request({"type": "http", "method": method, "headers": [
        (key.lower().encode(), value.encode()) for key, value in headers.items()
    ]})


def wait_for_lock(observer, pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if observer.scalar(text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"), {"pid": pid}):
            return
        time.sleep(0.01)
    pytest.fail("Expected the independent transaction to wait for the token row lock")


@pytest.mark.parametrize("mode", ["all", "selected"])
@pytest.mark.parametrize("first", ["edit", "create"])
def test_concurrent_browser_patch_and_bearer_creation(mode, first):
    schema = "token_concurrency_" + m.uid().replace("-", "")
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    isolated = create_engine(engine.url, connect_args={
        "options": f"-csearch_path={schema} -cstatement_timeout=10000"
    })
    try:
        Base.metadata.create_all(isolated)
        with Session(isolated, expire_on_commit=False) as setup:
            user = m.User(email="concurrent@example.invalid", name="Synthetic", verified=True,
                          password_hash="unused")
            setup.add(user)
            setup.flush()
            token = m.ApiToken(user_id=user.id, name="Concurrent", prefix="tc_test", token_hash=digest("bearer"),
                               scopes=["projects:read", "projects:create"], project_ids=[],
                               expires_at=m.now() + timedelta(days=1))
            setup.add_all([token, m.Session(user_id=user.id, token_hash=digest("browser"), csrf="csrf",
                                            expires_at=m.now() + timedelta(days=1))])
            setup.commit()
            token_id, user_id = token.id, user.id
        browser = request("PATCH", {"Cookie": "tc_session=browser", "X-CSRF-Token": "csrf"})
        bearer = request("POST", {"Authorization": "Bearer bearer"})
        update = TokenAccessUpdate(project_access=mode, project_ids=[], expected_version=1)
        pids = Queue()
        with Session(isolated, expire_on_commit=False) as first_db, ThreadPoolExecutor(max_workers=1) as pool:
            if first == "edit":
                first_db.scalar(select(m.ApiToken).where(m.ApiToken.id == token_id).with_for_update())

                def create():
                    with Session(isolated, expire_on_commit=False) as db:
                        pids.put(db.scalar(text("SELECT pg_backend_pid()")))
                        return action("create_project", Command(arguments={"name": "Future", "key": "FUT"}),
                                      bearer, db)

                future = pool.submit(create)
                wait_for_lock(first_db, pids.get(timeout=5))
                update_token_access(token_id, update, browser, first_db)
                project = future.result(timeout=10)
                expected_ids = [] if mode == "all" else [project["id"]]
                expected_version = 2 if mode == "all" else 3
            else:
                token = first_db.get(m.ApiToken, token_id)
                dispatch(first_db, Actor(first_db.get(m.User, user_id), token=token), "create_project",
                         arguments={"name": "First", "key": "FST"})
                first_db.flush()

                def edit():
                    with Session(isolated) as db:
                        pids.put(db.scalar(text("SELECT pg_backend_pid()")))
                        with pytest.raises(HTTPException) as error:
                            update_token_access(token_id, update, browser, db)
                        assert error.value.status_code == 409
                        assert error.value.detail["code"] == "VERSION_CONFLICT"

                future = pool.submit(edit)
                wait_for_lock(first_db, pids.get(timeout=5))
                expected_ids = list(token.project_ids)
                first_db.commit()
                future.result(timeout=10)
                mode, expected_version = "selected", 2
        with Session(isolated) as verify:
            latest = verify.get(m.ApiToken, token_id)
            assert (latest.project_access, latest.project_ids, latest.access_version) == (
                mode, expected_ids, expected_version)
    finally:
        isolated.dispose()
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
