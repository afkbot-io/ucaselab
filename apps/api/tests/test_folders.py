"""Folder changes preserve case histories, reject cycles and remain project scoped."""

import pytest
from app import models as m
from app.folders import MAX_DEPTH
from app.operations import dispatch
from app.security import Actor
from fastapi import HTTPException
from sqlalchemy import func, select


def expect_error(code, call, operation_name, **args):
    with pytest.raises(HTTPException) as exc:
        call(operation_name, **args)
    assert exc.value.detail["code"] == code


def test_folder_paths_search_pages_order_and_subtree_case_filter(call):
    root = call("create_folder", name="Вход")
    child = call("create_folder", name="Почта", parent_id=root["id"])
    leaf = call("create_folder", name="Пароль", parent_id=child["id"])
    direct = call("create_use_case", folder_id=root["id"], content={"title": "Логин"})
    nested = call("create_use_case", folder_id=leaf["id"], content={"title": "Смена пароля"})
    assert [p["name"] for p in leaf["path"]] == ["Вход", "Почта", "Пароль"]
    result = call("list_folders", search="Вход пароль", limit=1)
    assert result["items"][0]["id"] == leaf["id"] and result["total"] == 1
    assert call("list_folders", limit=1)["next_offset"] == 1
    assert call("list_folders", parent_id=root["id"])["items"][0]["id"] == child["id"]
    assert len(call("list_folders", roots_only=True)["items"]) == 1
    assert not call("list_folders", exclude_subtree_id=root["id"])["items"]
    assert call("get_folder", folder_id=root["id"])["total_use_case_count"] == 2
    assert [c["id"] for c in call("list_use_cases", folder_id=root["id"])["items"]] == [direct["id"]]
    assert {
        c["id"] for c in call("list_use_cases", folder_id=root["id"], include_subfolders=True)["items"]
    } == {direct["id"], nested["id"]}
    renamed = call("rename_folder", folder_id=child["id"], expected_version=child["version"], name="Email")
    assert renamed["parent_id"] == root["id"]
    assert call("get_folder", folder_id=leaf["id"])["path"][1]["name"] == "Email"


def test_move_branch_rejects_cycles_preserves_descendants_and_reorders(call):
    a = call("create_folder", name="A")
    b = call("create_folder", name="B")
    child = call("create_folder", name="Child", parent_id=a["id"])
    case = call("create_use_case", folder_id=child["id"], content={"title": "Кейс"})
    for parent in [a["id"], child["id"]]:
        expect_error(
            "FOLDER_CYCLE",
            call,
            "move_folder",
            folder_id=a["id"],
            expected_version=a["version"],
            parent_id=parent,
        )
    moved = call("move_folder", folder_id=a["id"], expected_version=a["version"], parent_id=b["id"])
    assert [p["id"] for p in call("get_folder", folder_id=child["id"])["path"]] == [
        b["id"],
        a["id"],
        child["id"],
    ]
    unchanged = call("get_use_case", use_case_id=case["id"])
    assert unchanged["revision_id"] == case["revision_id"] and unchanged["version"] == case["version"]
    expect_error("VERSION_CONFLICT", call, "move_folder", folder_id=a["id"], expected_version=a["version"])
    moved = call(
        "move_folder", folder_id=a["id"], expected_version=moved["version"], before_folder_id=b["id"]
    )
    assert [f["id"] for f in call("list_folders", roots_only=True)["items"]] == [a["id"], b["id"]]
    expect_error(
        "INVALID_FOLDER_ORDER",
        call,
        "move_folder",
        folder_id=a["id"],
        expected_version=moved["version"],
        before_folder_id=child["id"],
    )


def test_deleting_folder_moves_all_direct_contents_without_touching_revisions(db, call, content):
    parent = call("create_folder", name="Родитель")
    folder = call("create_folder", name="Удалить", parent_id=parent["id"])
    child = call("create_folder", name="Сохранить", parent_id=folder["id"])
    nested = call("create_use_case", folder_id=child["id"], content=content)
    case = call("create_use_case", folder_id=folder["id"], content=content)
    published = call(
        "publish_use_case",
        use_case_id=case["id"],
        expected_version=case["version"],
        revision_id=case["revision_id"],
        message="Публикация",
    )
    archived = call("create_use_case", folder_id=folder["id"], content={"title": "Архивный"})
    call("archive_use_case", object_id=archived["id"], expected_version=archived["version"])
    before_revisions = db.scalar(select(func.count()).select_from(m.UseCaseRevision))
    deleted = call("delete_folder", folder_id=folder["id"], expected_version=folder["version"])
    assert deleted["archived"] and deleted["moved_use_cases"] == 2 and deleted["moved_folders"] == 1
    assert call("get_folder", folder_id=child["id"])["parent_id"] == parent["id"]
    after = call("get_use_case", use_case_id=case["id"])
    assert (
        after["folder_id"] == parent["id"]
        and after["current_publication_id"] == published["current_publication_id"]
    )
    assert after["revision_id"] == published["revision_id"]
    assert call("get_use_case", use_case_id=nested["id"])["folder_id"] == child["id"]
    assert db.get(m.UseCase, archived["id"]).folder_id == parent["id"]
    assert db.scalar(select(func.count()).select_from(m.UseCaseRevision)) == before_revisions
    restored = call("restore_folder", folder_id=folder["id"], expected_version=deleted["version"])
    assert restored["parent_id"] is None and not restored["archived"]
    assert restored["total_use_case_count"] == 0
    assert call("get_use_case", use_case_id=case["id"])["folder_id"] == parent["id"]


def test_delete_destinations_validation_and_no_partial_move(call):
    root = call("create_folder", name="Источник")
    child = call("create_folder", name="Подпапка", parent_id=root["id"])
    target = call("create_folder", name="Получатель")
    case = call("create_use_case", folder_id=root["id"], content={"title": "Кейс"})
    expect_error(
        "FOLDER_CYCLE",
        call,
        "delete_folder",
        folder_id=root["id"],
        expected_version=root["version"],
        destination="folder",
        destination_folder_id=child["id"],
    )
    expect_error(
        "FOLDER_DESTINATION_REQUIRED",
        call,
        "delete_folder",
        folder_id=root["id"],
        expected_version=root["version"],
        destination="folder",
    )
    assert call("get_use_case", use_case_id=case["id"])["folder_id"] == root["id"]
    deleted = call(
        "delete_folder",
        folder_id=root["id"],
        expected_version=root["version"],
        destination="folder",
        destination_folder_id=target["id"],
    )
    assert deleted["destination_id"] == target["id"]
    assert call("get_folder", folder_id=child["id"])["parent_id"] == target["id"]
    target = call("get_folder", folder_id=target["id"])
    deleted_target = call(
        "delete_folder", folder_id=target["id"], expected_version=target["version"], destination="root"
    )
    assert deleted_target["destination_id"] is None
    assert call("get_use_case", use_case_id=case["id"])["folder_id"] is None


def test_folder_depth_guard_checks_whole_branch(call):
    root = call("create_folder", name="Уровень 1")
    parent = root
    for depth in range(2, MAX_DEPTH + 1):
        parent = call("create_folder", name=f"Уровень {depth}", parent_id=parent["id"])
    expect_error("FOLDER_DEPTH_LIMIT", call, "create_folder", name="Слишком глубоко", parent_id=parent["id"])
    branch = call("create_folder", name="Ветка")
    call("create_folder", name="Ребёнок", parent_id=branch["id"])
    expect_error(
        "FOLDER_DEPTH_LIMIT",
        call,
        "move_folder",
        folder_id=branch["id"],
        expected_version=branch["version"],
        parent_id=parent["id"],
    )


def test_folder_permissions_and_cross_project_targets(db, call, owner, project):
    folder = call("create_folder", name="Папка")
    foreign = dispatch(db, owner, "create_project", arguments={"name": "Другой", "key": "OTHER"})
    target = dispatch(db, owner, "create_folder", foreign["id"], {"name": "Чужая папка"})
    for op, args in [
        ("move_folder", {"parent_id": target["id"]}),
        ("delete_folder", {"destination": "folder", "destination_folder_id": target["id"]}),
    ]:
        expect_error(
            "NOT_FOUND", call, op, folder_id=folder["id"], expected_version=folder["version"], **args
        )
    developer = m.User(email=m.uid() + "@example.com", name="Dev", verified=True, password_hash="unused")
    db.add(developer)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=developer.id, role="developer"))
    db.flush()
    actor = Actor(developer)
    call("create_use_case", folder_id=folder["id"], content={"title": "Закрытый черновик"})
    assert dispatch(db, actor, "get_folder", project, {"folder_id": folder["id"]})["use_case_count"] == 0
    for op, args in [("delete_folder", {}), ("move_folder", {}), ("rename_folder", {"name": "Новое"})]:
        with pytest.raises(HTTPException) as exc:
            dispatch(
                db,
                actor,
                op,
                project,
                {"folder_id": folder["id"], "expected_version": folder["version"], **args},
            )
        assert exc.value.detail["code"] == "FORBIDDEN"


def test_legacy_archive_requires_empty_folder_and_restores_deleted_parent_safely(call):
    parent = call("create_folder", name="Parent")
    child = call("create_folder", name="Child", parent_id=parent["id"])
    expect_error(
        "FOLDER_NOT_EMPTY", call, "archive_folder", object_id=parent["id"], expected_version=parent["version"]
    )
    deleted = call("archive_folder", object_id=child["id"], expected_version=child["version"])
    call("delete_folder", folder_id=parent["id"], expected_version=parent["version"])
    restored = call(
        "archive_folder", object_id=child["id"], expected_version=deleted["version"], archived=False
    )
    assert restored["parent_id"] is None and not restored["archived"]


def test_empty_parent_is_validation_error_not_foreign_key_failure(call):
    expect_error("INVALID_FOLDER_PARENT", call, "create_folder", name="Папка", parent_id="")
    folder = call("create_folder", name="Папка")
    expect_error(
        "INVALID_FOLDER_PARENT",
        call,
        "move_folder",
        folder_id=folder["id"],
        expected_version=folder["version"],
        parent_id="",
    )
    assert call("get_folder", folder_id=folder["id"])["parent_id"] is None
