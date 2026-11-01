#!/usr/bin/env python3
"""Apply all migrations in an isolated schema and compare with application models."""
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'apps/api'))
from app.db import Base, engine
from app import models
from app.config import settings
schema='ucaselab_migration_check_'+uuid4().hex[:10]
with engine.begin() as conn:
    conn.execute(text(f'CREATE SCHEMA "{schema}"'))
try:
    url=make_url(settings().database_url).update_query_dict({'options':'-csearch_path='+schema})
    environment={**os.environ,'DATABASE_URL':url.render_as_string(hide_password=False)}
    result=subprocess.run(['uv','run','--frozen','alembic','upgrade','head'],cwd=root,env=environment,capture_output=True,text=True)
    if result.returncode:
        raise RuntimeError('Migration failed: '+result.stderr)
    check_engine=create_engine(url)
    with check_engine.connect() as conn:
        differences=compare_metadata(MigrationContext.configure(conn),Base.metadata)
        assert not differences, differences
        assert len(inspect(conn).get_table_names())==len(Base.metadata.tables)+1
    # Force both callers to read the same pre-lock state, then verify serialized writes.
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, local
    from unittest.mock import patch
    from sqlalchemy.orm import Session
    from fastapi import HTTPException
    from app.main import REGISTRY
    from app import models as m
    from app.operations import dispatch, membership as original_membership
    from app.security import Actor
    with Session(check_engine, expire_on_commit=False) as db:
        user=m.User(email='owner@migration.test',name='Migration check',verified=True,password_hash='unused')
        db.add(user); db.flush()
        owner_id=user.id
        project=dispatch(db,Actor(user),'create_project',arguments={'name':'Concurrency check','key':'CQ'})['id']
        targets=[]
        for i in range(2):
            member_user=m.User(email=f'target-{i}@migration.test',name=f'Target {i}',verified=True,password_hash='unused')
            db.add(member_user); db.flush()
            targets.append(member_user.id)
            db.add(m.Membership(project_id=project,user_id=member_user.id,role='tester'))
        db.commit()
    def race(operation, arguments):
        gate=Barrier(2)
        thread_state=local()
        def guarded(*args,**kwargs):
            result=original_membership(*args,**kwargs)
            if not getattr(thread_state,'checked',False):
                thread_state.checked=True
                gate.wait(timeout=10)
            return result
        def invoke(i):
            with Session(check_engine,expire_on_commit=False) as db:
                try:
                    result=dispatch(db,Actor(db.get(m.User,owner_id)),operation,project,arguments(i))
                    db.commit()
                    return ('ok',result)
                except HTTPException as exc:
                    db.rollback()
                    return ('error',exc.status_code)
        with patch('app.operations.membership',side_effect=guarded),ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(invoke,range(2)))
    created=race('create_use_case',lambda i:{'content':{'title':f'Concurrent case {i}'}})
    assert all(status=='ok' for status,_ in created)
    assert len({result['key'] for _,result in created})==2
    transferred=race('transfer_project_management',lambda i:{'new_owner_user_id':targets[i]})
    assert [status for status,_ in transferred].count('ok')==1
    assert [status for status,_ in transferred].count('error')==1
    with Session(check_engine) as db:
        owners=db.query(m.Membership).filter_by(project_id=project,role='owner').all()
        assert len(owners)==1 and owners[0].user_id==db.get(m.Project,project).owner_id
    print('Concurrent writes verified: unique case numbers and exactly one project owner')
    check_engine.dispose()
    print(f'Fresh migration verified: {len(Base.metadata.tables)} tables; no model/schema drift')
finally:
    with engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
