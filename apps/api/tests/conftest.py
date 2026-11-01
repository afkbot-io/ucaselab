import pytest
from app import models as m
from app.db import engine, get_db
from app.main import app
from app.operations import dispatch
from app.security import Actor, password_hasher
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session


@pytest.fixture
def db():
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False)
    yield session
    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture(scope="session")
def http_client():
    with TestClient(app) as shared:
        yield shared


@pytest.fixture
def client(db, http_client):
    def override():
        yield db

    app.dependency_overrides[get_db] = override
    http_client.cookies.clear()
    yield http_client
    app.dependency_overrides.clear()


@pytest.fixture
def owner(db):
    user = m.User(
        email=f"{m.uid()}@example.com",
        name="Руководитель",
        verified=True,
        password_hash=password_hasher.hash("password-12345"),
    )
    db.add(user)
    db.flush()
    return Actor(user)


@pytest.fixture
def project(db, owner):
    result = dispatch(db, owner, "create_project", arguments={"name": "Проверка платформы", "key": "QA"})
    db.flush()
    return result["id"]


@pytest.fixture
def call(db, owner, project):
    def invoke(operation_name, **arguments):
        result = dispatch(db, owner, operation_name, project, arguments)
        db.flush()
        return result

    return invoke


@pytest.fixture
def content():
    return {
        "title": "Регистрация",
        "goal": "Новый пользователь создаёт аккаунт",
        "steps": [
            {"key": "open", "action": "Открыть форму", "expected": "Форма регистрации отображается"},
            {
                "key": "submit",
                "action": "Отправить данные",
                "expected": "Результат соответствует варианту данных",
            },
        ],
        "variants": [
            {
                "key": "valid",
                "name": "Допустимые данные",
                "polarity": "positive",
                "inputs": {"email": "new@example.com"},
                "expected": "Аккаунт создан",
            },
            {
                "key": "invalid",
                "name": "Некорректная почта",
                "polarity": "negative",
                "inputs": {"email": "bad"},
                "expected": "Показана ошибка почты",
            },
        ],
    }


@pytest.fixture
def published(call, content):
    case = call("create_use_case", content=content)
    return call(
        "publish_use_case",
        use_case_id=case["id"],
        expected_version=case["version"],
        revision_id=case["revision_id"],
        message="Первая публикация",
    )


def approve_run(call, run):
    """Prepare a synthetic unit-test target; never attest availability of a real deployment."""
    call(
        "confirm_run_readiness",
        run_id=run["id"],
        expected_version=run["version"],
        checks={
            "environment": "ready",
            "accounts": "ready" if any(i["snapshot"]["accounts"] for i in run["items"]) else "not_required",
            "dependencies": "not_required",
        },
        actual_base_url="https://qa.example.test",
        notes="Синтетический стенд для проверки механизма прогонов",
    )
    return call("get_run", run_id=run["id"])
