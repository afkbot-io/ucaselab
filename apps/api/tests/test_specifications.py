"""Specification authoring, independent folders, pinned requirements and QA proposal application."""

import copy

import pytest
from app import models as m
from app.operations import dispatch
from app.security import Actor
from fastapi import HTTPException
from sqlalchemy import func, select


def error(code, invoke, operation_name, **arguments):
    with pytest.raises(HTTPException) as exc:
        invoke(operation_name, **arguments)
    assert exc.value.detail["code"] == code


def test_specification_folders_are_independent_and_keep_history_on_delete(call):
    case_folder = call("create_folder", name="Правила")
    root = call("create_specification_folder", name="Правила")
    child = call("create_specification_folder", name="Вход", parent_id=root["id"])
    spec = call("create_specification", title="Пароль", folder_id=root["id"])
    archived = call("create_specification", title="Старое правило", folder_id=root["id"])
    call("delete_specification", specification_id=archived["id"], expected_version=archived["version"])
    nested = call("create_specification", title="Почта", folder_id=child["id"])
    assert [f["id"] for f in call("list_folders")["items"]] == [case_folder["id"]]
    assert {f["id"] for f in call("list_specification_folders")["items"]} == {root["id"], child["id"]}
    counts = call("get_specification_folder", folder_id=root["id"])
    assert counts["item_count"] == 1 and counts["archived_item_count"] == 1
    assert counts["total_item_count"] == 2
    assert call("list_specifications", folder_id=root["id"])["total"] == 1
    assert call("list_specifications", folder_id=root["id"], include_subfolders=True)["total"] == 2
    assert call("list_specification_folders", search="Правила Вход")["items"][0]["id"] == child["id"]
    error("FOLDER_KIND_MISMATCH", call, "list_use_cases", folder_id=root["id"])
    error("FOLDER_KIND_MISMATCH", call, "create_specification", title="Ошибка", folder_id=case_folder["id"])
    error("FOLDER_KIND_MISMATCH", call, "create_use_case", content={"title": "Ошибка"}, folder_id=root["id"])
    error(
        "FOLDER_KIND_MISMATCH",
        call,
        "move_specification_folder",
        folder_id=root["id"],
        expected_version=root["version"],
        parent_id=case_folder["id"],
    )
    error(
        "FOLDER_CYCLE",
        call,
        "move_specification_folder",
        folder_id=root["id"],
        expected_version=root["version"],
        parent_id=child["id"],
    )
    deleted = call("delete_specification_folder", folder_id=root["id"], expected_version=root["version"])
    assert deleted["moved_specifications"] == 2 and deleted["moved_folders"] == 1
    for item in [spec, archived]:
        current = call("get_specification", specification_id=item["id"])
        assert current["folder_id"] is None and current["current_revision_id"] == item["current_revision_id"]
    assert call("get_specification_folder", folder_id=child["id"])["parent_id"] is None
    assert call("get_specification", specification_id=nested["id"])["folder_id"] == child["id"]
    restored = call("restore_specification_folder", folder_id=root["id"], expected_version=deleted["version"])
    assert restored["total_item_count"] == 0


def test_specification_updates_preserve_folder_revisions_and_search(call):
    folder = call("create_specification_folder", name="Вход")
    spec = call(
        "create_specification",
        title="  Правила входа  ",
        description="Пароль",
        acceptance_criteria="Не короче 8 символов",
        tags=["AUTH", "auth"],
        folder_id=folder["id"],
    )
    assert spec["title"] == "Правила входа" and len(spec["tags"]) == 1
    args = {
        "specification_id": spec["id"],
        "expected_version": spec["version"],
        "title": spec["title"],
        "description": spec["description"],
        "acceptance_criteria": spec["acceptance_criteria"],
        "tags": spec["tags"],
    }
    assert call("update_specification", **args) == spec
    updated = call("update_specification", **{**args, "acceptance_criteria": "От 12 символов"})
    assert (
        updated["folder_id"] == folder["id"] and updated["current_revision_id"] != spec["current_revision_id"]
    )
    error("VERSION_CONFLICT", call, "update_specification", **args)
    moved = call("move_specification", specification_id=spec["id"], expected_version=updated["version"])
    assert moved["folder_id"] is None and moved["current_revision_id"] == updated["current_revision_id"]
    assert (
        call("list_specifications", search="входа 12", tags=spec["tags"], without_folder=True)["total"] == 1
    )
    history = call("list_specification_revisions", specification_id=spec["id"], limit=1)
    assert history["total"] == 2 and history["next_offset"] == 1
    old = call(
        "get_specification_revision", specification_id=spec["id"], revision_id=spec["current_revision_id"]
    )
    assert old["content"]["acceptance_criteria"] == "Не короче 8 символов"
    deleted = call("delete_specification", specification_id=spec["id"], expected_version=moved["version"])
    assert deleted["archived"] and deleted["current_revision_id"] == moved["current_revision_id"]
    assert (
        call("list_specifications")["total"] == 0 and call("list_specifications", archived=True)["total"] == 1
    )
    assert not call(
        "restore_specification", specification_id=spec["id"], expected_version=deleted["version"]
    )["archived"]
    error("SPECIFICATION_TITLE_REQUIRED", call, "create_specification", title="   ")


def test_link_specifications_pins_revisions_and_retains_archived_links(call, content):
    one = call("create_specification", title="Вход", description="Первая версия")
    two = call("create_specification", title="Выход")
    case = call("create_use_case", content=content)
    linked = call(
        "set_use_case_specifications",
        use_case_id=case["id"],
        expected_version=case["version"],
        base_revision_id=case["revision_id"],
        specifications=[{"specification_id": one["id"]}, {"specification_id": two["id"]}],
    )
    assert linked["content"]["specifications"][0]["revision_id"] == one["current_revision_id"]
    for key in ["steps", "variants", "goal"]:
        assert linked["content"][key] == case["content"][key]
    updated = call(
        "update_specification",
        specification_id=one["id"],
        expected_version=one["version"],
        title="Вход",
        description="Вторая версия",
    )
    unchanged = call("get_use_case", use_case_id=case["id"])
    assert unchanged["content"]["specifications"][0]["revision_id"] == one["current_revision_id"]
    error(
        "INVALID_SPECIFICATION_REVISION",
        call,
        "set_use_case_specifications",
        use_case_id=case["id"],
        expected_version=linked["version"],
        base_revision_id=linked["revision_id"],
        specifications=[{"specification_id": one["id"], "revision_id": two["current_revision_id"]}],
    )
    error(
        "DUPLICATE_SPECIFICATION",
        call,
        "set_use_case_specifications",
        use_case_id=case["id"],
        expected_version=linked["version"],
        base_revision_id=linked["revision_id"],
        specifications=[{"specification_id": one["id"]}, {"specification_id": one["id"]}],
    )
    assert call("get_use_case", use_case_id=case["id"])["revision_id"] == linked["revision_id"]
    call("delete_specification", specification_id=one["id"], expected_version=updated["version"])
    changed = copy.deepcopy(linked["content"])
    changed["goal"] = "Изменение другой части кейса"
    saved = call(
        "save_use_case_draft",
        use_case_id=case["id"],
        expected_version=linked["version"],
        base_revision_id=linked["revision_id"],
        content=changed,
    )
    assert saved["content"]["specifications"] == linked["content"]["specifications"]
    error(
        "SPECIFICATION_ARCHIVED",
        call,
        "create_use_case",
        content={
            "title": "Новая связь",
            "specifications": [{"specification_id": one["id"], "revision_id": one["current_revision_id"]}],
        },
    )
    cleared = call(
        "set_use_case_specifications",
        use_case_id=case["id"],
        expected_version=saved["version"],
        base_revision_id=saved["revision_id"],
        specifications=[],
    )
    assert cleared["content"]["specifications"] == []


def test_specification_scope_and_cross_project_guards(db, owner, project, call):
    token = m.ApiToken(
        user_id=owner.user.id,
        prefix="test",
        token_hash="unique-test-spec-token",
        scopes=["projects:read", "specifications:write"],
        project_ids=[project],
        expires_at=m.now(),
    )
    actor = Actor(owner.user, token=token)
    folder = dispatch(db, actor, "create_specification_folder", project, {"name": "Папка"})
    spec = dispatch(
        db, actor, "create_specification", project, {"title": "Правило", "folder_id": folder["id"]}
    )
    with pytest.raises(HTTPException) as exc:
        dispatch(db, actor, "create_folder", project, {"name": "Недоступно"})
    assert exc.value.detail["code"] == "INSUFFICIENT_SCOPE"
    other = dispatch(db, owner, "create_project", arguments={"name": "Чужой", "key": "OTHER"})
    other_folder = dispatch(db, owner, "create_specification_folder", other["id"], {"name": "Чужая"})
    error(
        "NOT_FOUND",
        call,
        "move_specification",
        specification_id=spec["id"],
        expected_version=spec["version"],
        folder_id=other_folder["id"],
    )
    foreign = dispatch(db, owner, "create_specification", other["id"], {"title": "Чужая"})
    error(
        "NOT_FOUND",
        call,
        "create_use_case",
        content={"title": "Кейс", "specifications": [{"specification_id": foreign["id"]}]},
    )
    dev = m.User(email=m.uid() + "@example.com", name="Разработчик", verified=True, password_hash="unused")
    db.add(dev)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=dev.id, role="developer"))
    db.flush()
    with pytest.raises(HTTPException) as exc:
        dispatch(
            db,
            Actor(dev),
            "delete_specification",
            project,
            {"specification_id": spec["id"], "expected_version": spec["version"]},
        )
    assert exc.value.detail["code"] == "FORBIDDEN"


def test_qa_prepares_another_authors_proposal_and_applies_without_publishing(
    db, owner, project, call, content
):
    dev = m.User(email=m.uid() + "@example.com", name="Автор", verified=True, password_hash="unused")
    db.add(dev)
    db.flush()
    db.add(m.Membership(project_id=project, user_id=dev.id, role="developer"))
    db.flush()
    author = Actor(dev)
    original = dispatch(
        db,
        author,
        "submit_proposal",
        project,
        {
            "title": "Создать сценарий",
            "kind": "new_use_case",
            "content": {"description": "Исходная идея разработчика"},
        },
    )
    prepared = call(
        "prepare_proposal",
        proposal_id=original["id"],
        expected_version=original["version"],
        items=[{"action": "create_use_case", "content": content}],
    )
    assert (
        prepared["author_id"] == dev.id
        and prepared["content"]["description"] == original["content"]["description"]
    )
    assert call("list_use_cases")["total"] == 0
    preview = call("preview_proposal", proposal_id=original["id"])
    assert preview["changes"] and not preview["conflicts"]
    applied = dispatch(
        db,
        owner,
        "accept_proposal",
        project,
        {"proposal_id": prepared["id"], "expected_version": prepared["version"]},
        idempotency_key="qa-apply-once",
    )
    assert applied == dispatch(
        db,
        owner,
        "accept_proposal",
        project,
        {"proposal_id": prepared["id"], "expected_version": prepared["version"]},
        idempotency_key="qa-apply-once",
    )
    assert call("list_use_cases")["total"] == 1
    case = call("get_use_case", use_case_id=applied["decision"]["applied_items"][0]["use_case_id"])
    assert case["current_publication_id"] is None
    changed = {**case["content"], "goal": "Изменённая цель"}
    suggestion = call(
        "submit_proposal",
        title="Уточнение",
        kind="update_use_case",
        target_use_case_id=case["id"],
        content={"description": "Уточнить цель"},
    )
    suggestion = call(
        "prepare_proposal",
        proposal_id=suggestion["id"],
        expected_version=suggestion["version"],
        items=[
            {
                "action": "update_use_case",
                "use_case_id": case["id"],
                "base_revision_id": case["revision_id"],
                "content": changed,
            }
        ],
    )
    call("accept_proposal", proposal_id=suggestion["id"], expected_version=suggestion["version"])
    result = call("get_use_case", use_case_id=case["id"])
    assert (
        result["content"]["goal"] == changed["goal"]
        and result["content"]["steps"] == case["content"]["steps"]
    )
    assert (
        db.scalar(
            select(func.count()).select_from(m.Publication).where(m.Publication.use_case_id == case["id"])
        )
        == 0
    )


def test_export_includes_independent_folders_and_pinned_archived_requirement(call):
    folder = call("create_specification_folder", name="Правила")
    case_folder = call("create_folder", name="Сценарии")
    spec = call(
        "create_specification", title="Требование", description="Первая версия", folder_id=folder["id"]
    )
    case = call(
        "create_use_case",
        folder_id=case_folder["id"],
        content={"title": "Функция", "specifications": [{"specification_id": spec["id"]}]},
    )
    updated = call(
        "update_specification",
        specification_id=spec["id"],
        expected_version=spec["version"],
        title="Требование",
        description="Новая версия",
    )
    call("delete_specification", specification_id=spec["id"], expected_version=updated["version"])
    exported = call("export_project")
    assert [obj["id"] for obj in exported["folders"]] == [case_folder["id"]]
    assert [obj["id"] for obj in exported["specification_folders"]] == [folder["id"]]
    assert exported["specifications"][0]["archived"] is True
    revisions = {revision["id"]: revision for revision in exported["specification_revisions"]}
    assert revisions[spec["current_revision_id"]]["content"]["description"] == "Первая версия"
    assert revisions[updated["current_revision_id"]]["content"]["description"] == "Новая версия"
    link = exported["use_cases"][0]["content"]["specifications"][0]
    assert link["revision_id"] in revisions and exported["use_cases"][0]["id"] == case["id"]
