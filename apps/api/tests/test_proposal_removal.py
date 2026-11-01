"""Rejected proposal removal preserves evidence and removes every normal access path."""

from datetime import timedelta

import pytest
from app import models as m
from app.operations import dispatch
from app.security import Actor
from fastapi import HTTPException
from sqlalchemy import select
from test_attention import participant


def proposal_for(db, project, call, author):
    proposal = dispatch(
        db,
        author,
        "submit_proposal",
        project,
        {
            "title": "Удаляемое предложение",
            "kind": "implementation_change",
            "content": {
                "description": "Синтетическое изменение",
                "repository": "synthetic/repo",
                "commit_sha": "f" * 40,
            },
        },
    )
    thread = dispatch(
        db,
        author,
        "create_comment_thread",
        project,
        {
            "target_type": "proposal",
            "target_id": proposal["id"],
            "body": "История обсуждения",
        },
    )
    rejected = call("reject_proposal", proposal_id=proposal["id"], expected_version=1, reason="Дубликат")
    return rejected, thread


def test_removal_preserves_evidence_and_hides_all_projections(db, project, call):
    author, _ = participant(db, project, "developer")
    proposal, thread = proposal_for(db, project, call, author)
    pid = proposal["id"]
    before = dispatch(db, author, "get_project_attention", project)
    assert before["sections"]["proposals"] > 0
    result = dispatch(db, author, "delete_proposal", project, {"proposal_id": pid, "expected_version": 2})
    assert result == {"id": pid, "archived": True, "version": 3}
    stored = db.get(m.Proposal, pid)
    assert stored.archived and stored.status == "rejected"
    assert stored.decision == proposal["decision"] and stored.content == proposal["content"]
    assert len(list(db.scalars(select(m.ProposalRevision).where(m.ProposalRevision.proposal_id == pid)))) == 1
    assert db.get(m.Thread, thread["id"]) is not None
    assert db.scalar(select(m.Audit).where(m.Audit.action == "proposal.deleted", m.Audit.resource_id == pid))
    for actor in [author, None]:

        def invoke(name, **args):
            return dispatch(db, actor, name, project, args) if actor else call(name, **args)

        assert invoke("list_proposals", status="rejected")["total"] == 0
        assert not invoke("check_change_proposals", repository="synthetic/repo", commit_sha="f" * 40)[
            "covered"
        ]
        assert invoke("get_project_attention")["sections"]["proposals"] == 0
        assert invoke("list_notifications")["items"] == []
        assert invoke("list_activity")["items"] == []
        for name, args in [
            ("get_proposal", {"proposal_id": pid}),
            ("list_proposal_revisions", {"proposal_id": pid}),
            ("list_comment_threads", {"target_type": "proposal", "target_id": pid}),
            ("create_comment_thread", {"target_type": "proposal", "target_id": pid, "body": "Нельзя"}),
            ("create_comment", {"thread_id": thread["id"], "body": "Нельзя"}),
            ("delete_proposal", {"proposal_id": pid, "expected_version": 2}),
        ]:
            with pytest.raises(HTTPException) as error:
                invoke(name, **args)
            assert error.value.status_code == 404
    for name, args in [
        ("preview_proposal", {}),
        ("prepare_proposal", {"expected_version": 3, "items": []}),
        ("update_proposal", {"expected_version": 3, "title": "Правка", "content": {"description": "Нет"}}),
        ("accept_proposal", {"expected_version": 3}),
        ("reject_proposal", {"expected_version": 3, "reason": "Нет"}),
        ("withdraw_proposal", {"expected_version": 3}),
    ]:
        with pytest.raises(HTTPException) as error:
            call(name, proposal_id=pid, **args)
        assert error.value.status_code == 404


@pytest.mark.parametrize("role", ["developer", "tester", "manager", "owner"])
def test_author_and_qa_can_remove_rejected(db, project, call, role):
    author, _ = participant(db, project, "developer")
    proposal, _ = proposal_for(db, project, call, author)
    actor = author if role == "developer" else participant(db, project, role)[0]
    assert dispatch(
        db,
        actor,
        "delete_proposal",
        project,
        {
            "proposal_id": proposal["id"],
            "expected_version": 2,
        },
    )["archived"]


def test_removal_rejects_other_states_and_stale_versions(db, project, call):
    author, _ = participant(db, project, "developer")
    for state in ["open", "accepted", "withdrawn", "rejected"]:
        proposal = dispatch(
            db,
            author,
            "submit_proposal",
            project,
            {
                "title": "Проверка статуса",
                "kind": "feature_idea",
                "content": {"description": "Идея"},
            },
        )
        obj = db.get(m.Proposal, proposal["id"])
        obj.status = state
        db.flush()
        with pytest.raises(HTTPException) as error:
            call("delete_proposal", proposal_id=obj.id, expected_version=0 if state == "rejected" else 1)
        assert error.value.detail["code"] == (
            "VERSION_CONFLICT" if state == "rejected" else "PROPOSAL_NOT_REJECTED"
        )
        assert not obj.archived


def test_removal_authorization_and_token_scopes(db, project, call):
    author, member = participant(db, project, "developer")
    other, _ = participant(db, project, "developer")
    qa, _ = participant(db, project, "tester")
    proposal, _ = proposal_for(db, project, call, author)
    args = {"proposal_id": proposal["id"], "expected_version": 2}
    with pytest.raises(HTTPException) as error:
        dispatch(db, other, "delete_proposal", project, args)
    assert error.value.status_code == 404

    def token_actor(actor, scopes, projects=None):
        token = m.ApiToken(
            user_id=actor.user.id,
            name="synthetic",
            prefix="test",
            token_hash=m.uid(),
            scopes=scopes,
            project_ids=projects if projects is not None else [project],
            expires_at=m.now() + timedelta(days=1),
        )
        return Actor(actor.user, token=token)

    for actor in [
        token_actor(author, ["projects:read"]),
        token_actor(qa, ["projects:read", "proposals:write"]),
        token_actor(qa, ["projects:read", "proposals:review"]),
        token_actor(author, ["projects:read", "proposals:write"], []),
    ]:
        with pytest.raises(HTTPException) as error:
            dispatch(db, actor, "delete_proposal", project, args)
        assert error.value.status_code in (403, 404)
    foreign = dispatch(db, qa, "create_project", arguments={"name": "Другой", "key": "OTHER"})["id"]
    db.add(m.Membership(project_id=foreign, user_id=author.user.id, role="developer"))
    db.flush()
    with pytest.raises(HTTPException) as error:
        dispatch(db, author, "delete_proposal", foreign, args)
    assert error.value.status_code == 404
    db.delete(member)
    db.flush()
    with pytest.raises(HTTPException) as error:
        dispatch(db, author, "delete_proposal", project, args)
    assert error.value.status_code == 404
    assert dispatch(
        db,
        token_actor(qa, ["projects:read", "proposals:write", "proposals:review"]),
        "delete_proposal",
        project,
        args,
    )["archived"]


def test_concurrent_removal_has_one_winner_and_one_audit():
    """Separate sessions preload the proposal before racing for the project lock."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from app.db import Base, engine
    from sqlalchemy import func, text
    from sqlalchemy.orm import Session

    schema = "proposal_race_" + m.uid().replace("-", "")
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    isolated = engine.execution_options(schema_translate_map={None: schema})
    try:
        Base.metadata.create_all(isolated)
        with Session(isolated, expire_on_commit=False) as session:
            user = m.User(email="race@example.invalid", name="Race", verified=True, password_hash="unused")
            session.add(user)
            session.flush()
            actor = Actor(user)
            project = dispatch(session, actor, "create_project", arguments={"name": "Race", "key": "RACE"})[
                "id"
            ]
            proposal = dispatch(
                session,
                actor,
                "submit_proposal",
                project,
                {
                    "title": "Race",
                    "kind": "feature_idea",
                    "content": {"description": "Idea"},
                },
            )
            dispatch(
                session,
                actor,
                "reject_proposal",
                project,
                {
                    "proposal_id": proposal["id"],
                    "expected_version": 1,
                    "reason": "Duplicate",
                },
            )
            user_id, pid = user.id, proposal["id"]
            session.commit()
        barrier = Barrier(2)

        def remove():
            with Session(isolated) as session:
                actor = Actor(session.get(m.User, user_id))
                cached = session.get(m.Proposal, pid)
                assert not cached.archived
                barrier.wait(timeout=5)
                try:
                    result = dispatch(
                        session,
                        actor,
                        "delete_proposal",
                        project,
                        {
                            "proposal_id": pid,
                            "expected_version": 2,
                        },
                    )
                    session.commit()
                    return result["archived"]
                except HTTPException as error:
                    session.rollback()
                    return error.detail["code"]

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(remove) for _ in range(2)]
            outcomes = [future.result(timeout=10) for future in futures]
        assert outcomes.count(True) == 1 and outcomes.count("NOT_FOUND") == 1
        with Session(isolated) as session:
            assert session.get(m.Proposal, pid).version == 3
            assert (
                session.scalar(
                    select(func.count())
                    .select_from(m.Audit)
                    .where(
                        m.Audit.action == "proposal.deleted",
                        m.Audit.resource_id == pid,
                    )
                )
                == 1
            )
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
