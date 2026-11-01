"""Exercise every registered operation's permission boundary, not just representative buttons."""

import pytest
from app import models as m
from app.operations import REGISTRY, dispatch
from app.security import ROLE_RANK, Actor
from fastapi import HTTPException


@pytest.mark.parametrize("role", ["developer", "tester", "manager"])
def test_every_project_operation_denies_lower_roles_before_processing_arguments(db, project, role):
    user = m.User(email=f"{m.uid()}@example.com", name=role, verified=True, password_hash="unused")
    db.add(user)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=user.id, role=role))
    db.flush()
    denied = []
    for name, operation in REGISTRY.items():
        if operation["global_"] or ROLE_RANK[role] >= ROLE_RANK[operation["role"]]:
            continue
        with pytest.raises(HTTPException) as error:
            dispatch(db, Actor(user), name, project, {})
        assert error.value.status_code == 403, (role, name, error.value.detail)
        denied.append(name)
    assert denied


def test_every_operation_requires_its_declared_token_scope(db, owner, project):
    for name, operation in REGISTRY.items():
        token = m.ApiToken(
            user_id=owner.user.id,
            name="Scope boundary",
            token_hash="test",
            prefix="test",
            scopes=[],
            project_ids=[project],
            expires_at=m.now(),
        )
        with pytest.raises(HTTPException) as error:
            dispatch(db, Actor(owner.user, token=token), name, project, {})
        assert error.value.detail["code"] == "INSUFFICIENT_SCOPE", name
        assert operation["scope"] in error.value.detail["message"], name
