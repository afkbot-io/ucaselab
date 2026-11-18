"""Browser-owned access settings and live bearer project boundaries."""
from app import models as m
from app.operations import dispatch
from sqlalchemy import select


def login(client, owner):
    result = client.post('/api/auth/login', json={'email': owner.user.email, 'password': 'password-12345'})
    return {'X-CSRF-Token': result.json()['csrf']}


def test_same_bearer_dynamic_access_and_safe_legacy(client, db, owner, project):
    headers = login(client, owner)
    legacy = client.post('/api/tokens', headers=headers, json={'name': 'legacy', 'scopes': ['projects:read']})
    assert legacy.status_code == 200
    assert client.get('/api/tokens', headers=headers).json()['items'][0]['project_access'] == 'selected'
    created = client.post('/api/tokens', headers=headers, json={
        'name': 'dynamic', 'scopes': ['projects:read'], 'project_access': 'all', 'project_ids': []})
    assert created.status_code == 200
    raw, token_id = created.json()['token'], created.json()['id']
    bearer = {'Authorization': 'Bearer ' + raw}
    future = dispatch(db, owner, 'create_project', arguments={'name': 'Future', 'key': 'FUT'})['id']
    listed = client.post('/api/actions/list_projects', headers=bearer, json={})
    assert listed.status_code == 200, listed.text
    assert {x['id'] for x in listed.json()['items']} == {project, future}
    token = db.get(m.ApiToken, token_id)
    identity = token.token_hash, token.prefix, token.expires_at
    edited = client.patch('/api/tokens/' + token_id, headers=headers, json={
        'project_access': 'selected', 'project_ids': [future], 'expected_version': 1})
    assert edited.status_code == 200, edited.text
    assert 'token_hash' not in edited.text and raw not in edited.text
    assert (token.token_hash, token.prefix, token.expires_at) == identity
    assert client.post('/api/actions/get_project_context', headers=bearer, json={'project_id': project}).status_code == 404
    assert client.patch('/api/tokens/' + token_id, headers=headers, json={
        'project_access': 'all', 'project_ids': [], 'expected_version': 1}).status_code == 409
    assert client.patch('/api/tokens/' + token_id, headers=bearer, json={
        'project_access': 'all', 'project_ids': [], 'expected_version': 2}).status_code == 403
    assert db.scalar(select(m.ApiToken.project_ids).where(m.ApiToken.id == token_id)) == [future]


def test_validation_management_and_inactive_tokens(client, db, owner, project):
    from datetime import timedelta
    headers = login(client, owner)
    duplicate = client.post(
        "/api/tokens", headers=headers,
        json={"name": "compatible", "scopes": ["projects:read", "projects:read"]},
    )
    assert duplicate.status_code == 200
    assert db.get(m.ApiToken, duplicate.json()["id"]).scopes == ["projects:read"]
    base = {'name': 'safe', 'scopes': ['projects:read'], 'project_ids': [project]}
    for patch, status in [
        ({'project_access': 'all'}, 422), ({'project_access': 'unknown'}, 422),
        ({'project_ids': [project, project]}, 422), ({'project_ids': [123]}, 422),
        ({'project_ids': ['unknown']}, 404), ({'expires_days': True}, 422),
        ({'scopes': ['bad']}, 400),
    ]:
        assert client.post('/api/tokens', headers=headers, json={**base, **patch}).status_code == status
    created = client.post('/api/tokens', headers=headers, json=base).json()
    path = '/api/tokens/' + created['id']
    update = {'project_access': 'all', 'project_ids': [], 'expected_version': 1}
    assert client.patch(path, json=update).status_code == 403
    assert client.patch(path, headers={**headers, 'Origin': 'https://outsider.invalid'}, json=update).status_code == 403
    bearer = {'Authorization': 'Bearer ' + created['token']}
    assert client.get('/api/tokens', headers=bearer).status_code == 403
    assert client.post('/api/tokens', headers=bearer, json=base).status_code == 403
    assert client.delete(path, headers=bearer).status_code == 403
    assert client.patch('/api/tokens/' + m.uid(), headers=headers, json=update).status_code == 404
    other = m.User(email=m.uid()+'@example.invalid', name='Other', password_hash='unused', verified=True)
    db.add(other)
    db.flush()
    token = db.get(m.ApiToken, created['id'])
    token.user_id = other.id
    db.flush()
    assert client.patch(path, headers=headers, json=update).status_code == 404
    token.user_id = owner.user.id
    token.expires_at = m.now() - timedelta(seconds=1)
    db.flush()
    assert client.patch(path, headers=headers, json=update).status_code == 409
    token.expires_at = m.now() + timedelta(days=1)
    token.revoked = True
    db.flush()
    assert client.patch(path, headers=headers, json=update).status_code == 409
    assert token.revoked and token.access_version == 1


def test_membership_archive_and_safe_narrowing(client, db, owner, project):
    headers = login(client, owner)
    created = client.post('/api/tokens', headers=headers, json={
        'name': 'all', 'scopes': ['projects:read', 'use_cases:write'], 'project_access': 'all'}).json()
    bearer = {'Authorization': 'Bearer '+created['token']}
    def context(pid):
        return client.post('/api/actions/get_project_context', headers=bearer, json={'project_id': pid})
    foreign = m.User(email=m.uid()+'@example.invalid', name='Foreign', password_hash='unused', verified=True)
    db.add(foreign)
    db.flush()
    outsider = m.Project(name='Private', key='OUT', owner_id=foreign.id)
    db.add(outsider)
    db.flush()
    assert context(outsider.id).status_code == 404
    # Joining later is included; all mode is never a snapshot.
    joined = m.Membership(project_id=outsider.id, user_id=owner.user.id, role='developer')
    db.add(joined)
    db.flush()
    assert context(outsider.id).status_code == 200
    db.delete(joined)
    db.flush()
    assert context(outsider.id).status_code == 404
    p = db.get(m.Project, project)
    p.archived = True
    db.flush()
    # Context explicitly allows archived projects; writes still reject them.
    denied = client.post('/api/actions/create_folder', headers=bearer,
                         json={'project_id': project, 'arguments': {'name': 'No'}})
    assert denied.status_code == 409
    assert denied.json()['detail']['code'] == 'PROJECT_ARCHIVED'
    p.archived = False
    db.flush()
    assert client.post('/api/actions/create_folder', headers=bearer,
                       json={'project_id': project, 'arguments': {'name': 'Restored'}}).status_code == 200
    assert context(project).status_code == 200
    path = '/api/tokens/' + created['id']
    assert client.patch(path, headers=headers, json={
        'project_access': 'selected', 'project_ids': [project], 'expected_version': 1}).status_code == 200
    member = db.scalar(select(m.Membership).where(m.Membership.project_id == project, m.Membership.user_id == owner.user.id))
    db.delete(member)
    db.flush()
    assert context(project).status_code == 404
    assert client.patch(path, headers=headers, json={
        'project_access': 'selected', 'project_ids': [], 'expected_version': 2}).status_code == 200
    assert client.post('/api/actions/list_projects', headers=bearer, json={}).json()['items'] == []


def test_create_project_auto_grant_uses_latest_locked_settings(db, owner, project):
    """Simulate an actor loaded before a settings edit; a stale JSON list must not win."""
    from datetime import timedelta

    from app.security import Actor
    from sqlalchemy import update
    token = m.ApiToken(user_id=owner.user.id, name='creator', token_hash=m.uid(), prefix='tc_test',
                       scopes=['projects:read', 'projects:create'], project_ids=[project],
                       expires_at=m.now()+timedelta(days=1))
    db.add(token)
    db.flush()
    actor = Actor(owner.user, token=token)
    for mode, ids, version in [('all', [], 2), ('selected', [], 3)]:
        db.execute(update(m.ApiToken).where(m.ApiToken.id == token.id).values(
            project_access=mode, project_ids=ids, access_version=version).execution_options(synchronize_session=False))
        result = dispatch(db, actor, 'create_project', arguments={'name': 'Created', 'key': 'CR'})
        db.flush()
        db.refresh(token)
        assert token.project_access == mode
        assert token.project_ids == ([] if mode == 'all' else [result['id']])
        assert token.access_version == (version if mode == 'all' else version+1)


def test_actual_upgrade_keeps_legacy_empty_and_selected_lists():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from app.db import engine
    from sqlalchemy import text
    from test_discussion_migration import load
    schema = 'migration_' + m.uid().replace('-', '')
    with engine.connect() as connection, connection.begin():
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
        with Operations.context(MigrationContext.configure(connection)):
            for name in ['0001_initial', '0002_catalog', '0003_specification_folders',
                         '0004_draft_runs_readiness', '0005_discussion_activity']:
                load(name).upgrade()
            user = m.uid()
            connection.execute(m.User.__table__.insert().values(id=user, email='legacy@example.invalid', name='Legacy', password_hash='unused'))
            for ids in ['[]', '["old-project"]']:
                connection.execute(text('''INSERT INTO api_tokens
                    (id, created_at, user_id, name, token_hash, prefix, scopes, project_ids, expires_at, revoked)
                    VALUES (:id, now(), :user, 'Legacy', :hash, 'tc_legacy', '["projects:read"]',
                    CAST(:ids AS json), now()+interval '1 day', false)'''),
                    {'id': m.uid(), 'user': user, 'hash': m.uid(), 'ids': ids})
            load('0006_token_project_access').upgrade()
            rows = connection.execute(select(m.ApiToken.project_access, m.ApiToken.access_version, m.ApiToken.project_ids)).all()
            assert {tuple((mode, version, tuple(ids))) for mode, version, ids in rows} == {
                ('selected', 1, ()), ('selected', 1, ('old-project',))}
            load('0006_token_project_access').downgrade()
            assert connection.scalar(text('SELECT count(*) FROM api_tokens')) == 2
        connection.rollback()


def test_activity_all_mode_filters_memberships_and_live_selection(client, db, owner, project, content):
    headers = login(client, owner)
    future = dispatch(db, owner, 'create_project', arguments={'name': 'Future', 'key': 'ACT'})['id']
    for pid in [project, future]:
        dispatch(db, owner, 'create_use_case', pid, {'content': content})
    created = client.post('/api/tokens', headers=headers, json={
        'name': 'activity', 'project_access': 'all', 'scopes': ['projects:read', 'notifications:read']}).json()
    bearer = {'Authorization': 'Bearer '+created['token']}
    def activity():
        result = client.post('/api/actions/list_activity', headers=bearer,
                             json={'project_id': project, 'arguments': {'all_projects': True}})
        assert result.status_code == 200, result.text
        return {item['project_id'] for item in result.json()['items']}
    assert activity() == {project, future}
    assert client.patch('/api/tokens/'+created['id'], headers=headers, json={
        'project_access': 'selected', 'project_ids': [project], 'expected_version': 1}).status_code == 200
    assert activity() == {project}
    assert client.patch('/api/tokens/'+created['id'], headers=headers, json={
        'project_access': 'all', 'project_ids': [], 'expected_version': 2}).status_code == 200
    db.get(m.Project, future).archived = True
    db.flush()
    assert activity() == {project}
    db.get(m.Project, future).archived = False
    db.flush()
    assert activity() == {project, future}
    member = db.scalar(select(m.Membership).where(m.Membership.project_id == future, m.Membership.user_id == owner.user.id))
    db.delete(member)
    db.flush()
    assert activity() == {project}


def test_open_sdk_session_rechecks_edited_same_bearer(client, db, owner, project, monkeypatch):
    import asyncio
    from contextlib import contextmanager

    import app.main as main
    import app.mcp_server as server
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    @contextmanager
    def scoped_session():
        yield db

    monkeypatch.setattr(main, 'SessionLocal', scoped_session)
    monkeypatch.setattr(server, 'SessionLocal', scoped_session)
    headers = login(client, owner)
    created = client.post('/api/tokens', headers=headers, json={
        'name': 'Open SDK session', 'project_access': 'all', 'scopes': ['projects:read']}).json()

    async def scenario():
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=main.app),
                                     headers={'Authorization': 'Bearer '+created['token']}) as http:
            async with streamable_http_client('http://testserver/mcp/', http_client=http) as streams:
                async with ClientSession(*streams) as session:
                    await session.initialize()
                    result = await session.call_tool('get_project_context', {'project_id': project})
                    assert not result.is_error
                    for mode, ids, version, denied in [('selected', [], 1, True), ('all', [], 2, False)]:
                        response = client.patch('/api/tokens/'+created['id'], headers=headers, json={
                            'project_access': mode, 'project_ids': ids, 'expected_version': version})
                        assert response.status_code == 200, response.text
                        result = await session.call_tool('get_project_context', {'project_id': project})
                        assert result.is_error == denied
                        if denied:
                            assert 'NOT_FOUND' in result.content[0].text
    asyncio.run(scenario())
