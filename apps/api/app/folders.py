"""Folder hierarchy and placement. Case revisions and published snapshots stay untouched."""

from collections import defaultdict, deque
from typing import Annotated, Literal

from pydantic import Field, StringConstraints
from sqlalchemy import func, select

from . import models as m
from .catalog import Limit, Offset, Search
from .operations import fields, operation
from .security import fail

Name = Annotated[str, StringConstraints(strip_whitespace=True), Field(min_length=1, max_length=160)]
MAX_DEPTH = 32


def require_folder(ctx, folder_id, kind="use_cases", archived=False):
    folder = ctx.get(m.Folder, folder_id, archived=archived)
    if folder.kind != kind:
        fail(
            "FOLDER_KIND_MISMATCH",
            "Выберите папку из нужного раздела: кейсы и спецификации хранятся отдельно",
            409,
        )
    return folder


class FolderContext:
    """Share hierarchy rules without mixing catalogs or their permission boundaries."""

    def __init__(self, base, kind):
        self.base, self.folder_kind = base, kind
        self.item_model = m.Specification if kind == "specifications" else m.UseCase
        self.item_event = "specification" if kind == "specifications" else "use_case"

    def __getattr__(self, name):
        return getattr(self.base, name)

    def get(self, model, object_id, archived=True):
        if model is m.Folder:
            return require_folder(self.base, object_id, self.folder_kind, archived)
        return self.base.get(model, object_id, archived=archived)


def scoped(ctx):
    return ctx if isinstance(ctx, FolderContext) else FolderContext(ctx, "use_cases")


def folder_nodes(ctx):
    return {
        f.id: f
        for f in ctx.db.scalars(
            select(m.Folder).where(
                m.Folder.project_id == ctx.project_id,
                m.Folder.kind == getattr(ctx, "folder_kind", "use_cases"),
            )
        )
    }


def path_for(nodes, folder_id):
    path, seen = [], set()
    while folder_id and folder_id in nodes and folder_id not in seen:
        seen.add(folder_id)
        folder = nodes[folder_id]
        path.append({"id": folder.id, "name": folder.name})
        folder_id = folder.parent_id
    return list(reversed(path))


def descendant_ids(nodes, folder_id):
    children = defaultdict(list)
    for folder in nodes.values():
        children[folder.parent_id].append(folder.id)
    result, queue = set(), deque([folder_id])
    while queue:
        current = queue.popleft()
        if current not in result:
            result.add(current)
            queue.extend(children[current])
    return result


def validate_parent(ctx, parent_id, current_id=None, nodes=None, enforce_depth=True):
    if parent_id == "":
        fail("INVALID_FOLDER_PARENT", "Для корня передайте null, для папки — её идентификатор")
    visited = {current_id} if current_id else set()
    depth = 0
    while parent_id:
        if parent_id in visited:
            fail("FOLDER_CYCLE", "Нельзя переместить папку в саму себя или её подпапку", 409)
        visited.add(parent_id)
        parent = ctx.get(m.Folder, parent_id, archived=False)
        parent_id = parent.parent_id
        depth += 1
    if not enforce_depth:
        return
    height = 1
    if current_id:
        nodes = nodes if nodes is not None else folder_nodes(ctx)
        children = defaultdict(list)
        for item in nodes.values():
            children[item.parent_id].append(item.id)
        queue, seen = deque([(current_id, 1)]), set()
        while queue:
            item_id, item_depth = queue.popleft()
            if item_id in seen:
                fail("FOLDER_CYCLE", "В ветке папок обнаружен цикл", 409)
            seen.add(item_id)
            height = max(height, item_depth)
            queue.extend((child, item_depth + 1) for child in children[item_id])
    if depth + height > MAX_DEPTH:
        fail("FOLDER_DEPTH_LIMIT", f"Допускается до {MAX_DEPTH} уровней папок. Выберите уровень выше", 409)


def statistics(ctx, nodes):
    ctx = scoped(ctx)
    model = ctx.item_model
    counts = ctx.db.execute(
        select(model.folder_id, model.archived, func.count())
        .where(
            model.project_id == ctx.project_id,
            *([] if ctx.qa or model is m.Specification else [m.UseCase.current_publication_id.is_not(None)]),
        )
        .group_by(model.folder_id, model.archived)
    ).all()
    direct: dict[str | None, int] = defaultdict(int)
    archived: dict[str | None, int] = defaultdict(int)
    totals: dict[str, int] = defaultdict(int)
    children: dict[str | None, int] = defaultdict(int)
    paths = {item.id: path_for(nodes, item.id) for item in nodes.values()}
    for folder_id, is_archived, count in counts:
        (archived if is_archived else direct)[folder_id] = count
        if not is_archived:
            for ancestor in paths.get(folder_id, []):
                totals[ancestor["id"]] += count
    for item in nodes.values():
        if not item.archived:
            children[item.parent_id] += 1
    return paths, direct, archived, totals, children


def folder_data(folder, stats):
    paths, direct, archived, totals, children = stats
    return {
        **fields(folder, "name", "parent_id", "position", "version", "archived", "kind"),
        "item_count": direct[folder.id],
        "archived_item_count": archived[folder.id],
        "total_item_count": totals[folder.id],
        "path": paths[folder.id],
        "depth": len(paths[folder.id]),
        ("specification_count" if folder.kind == "specifications" else "use_case_count"): direct[folder.id],
        (
            "archived_specification_count" if folder.kind == "specifications" else "archived_use_case_count"
        ): archived[folder.id],
        ("total_specification_count" if folder.kind == "specifications" else "total_use_case_count"): totals[
            folder.id
        ],
        "subfolder_count": children[folder.id],
    }


def data_for(ctx, folder):
    ctx.db.flush()
    nodes = folder_nodes(ctx)
    return folder_data(folder, statistics(ctx, nodes))


def ordered(nodes, parent_id, exclude=None):
    return sorted(
        (f for f in nodes.values() if not f.archived and f.parent_id == parent_id and f.id != exclude),
        key=lambda f: (f.position, f.name.casefold(), f.id),
    )


def append_position(nodes, parent_id):
    return max((f.position for f in ordered(nodes, parent_id)), default=-1) + 1


def clean_name(name):
    name = name.strip()
    if not name:
        fail("FOLDER_NAME_REQUIRED", "Укажите название папки")
    return name


@operation()
def list_folders(
    ctx,
    archived: bool = False,
    search: Search = "",
    parent_id: str | None = None,
    roots_only: bool = False,
    exclude_subtree_id: str | None = None,
    limit: Limit = 1000,
    offset: Offset = 0,
):
    """Папки с полными путями, порядком и счётчиками видимых кейсов. Поиск по пути; parent_id — прямые дети, roots_only — корень. exclude_subtree_id исключает ветку при выборе места. Страницы: total/next_offset."""
    ctx = scoped(ctx)
    nodes = folder_nodes(ctx)
    if parent_id:
        ctx.get(m.Folder, parent_id)
    if exclude_subtree_id:
        ctx.get(m.Folder, exclude_subtree_id)
    excluded = descendant_ids(nodes, exclude_subtree_id) if exclude_subtree_id else set()
    stats = statistics(ctx, nodes)
    words = search.casefold().split()
    items = [
        f
        for f in nodes.values()
        if f.archived == archived
        and f.id not in excluded
        and (not roots_only or f.parent_id is None)
        and (not parent_id or f.parent_id == parent_id)
        and all(word in " / ".join(p["name"] for p in stats[0][f.id]).casefold() for word in words)
    ]
    items.sort(key=lambda f: (f.position, f.name.casefold(), f.id))
    return {
        "items": [folder_data(f, stats) for f in items[offset : offset + limit]],
        "total": len(items),
        "next_offset": offset + limit if offset + limit < len(items) else None,
        "max_depth": MAX_DEPTH,
    }


@operation()
def get_folder(ctx, folder_id: str):
    """Полный путь папки и прямое содержимое: use_case_count, archived_use_case_count, subfolder_count. total_use_case_count включает подпапки. Подходит для проверки перед удалением."""
    ctx = scoped(ctx)
    return data_for(ctx, ctx.get(m.Folder, folder_id))


@operation("use_cases:write", "tester", write=True)
def create_folder(ctx, name: Name, parent_id: str | None = None):
    """Создать папку в корне или parent_id; вложенность ограничена 32 уровнями."""
    ctx = scoped(ctx)
    validate_parent(ctx, parent_id)
    nodes = folder_nodes(ctx)
    folder = m.Folder(
        project_id=ctx.project_id,
        name=clean_name(name),
        kind=ctx.folder_kind,
        parent_id=parent_id,
        position=append_position(nodes, parent_id),
    )
    ctx.db.add(folder)
    ctx.db.flush()
    ctx.audit("folder.created", folder.id, {"parent_id": parent_id})
    return data_for(ctx, folder)


def apply_move(ctx, folder, parent_id, before_folder_id=None):
    nodes = folder_nodes(ctx)
    validate_parent(ctx, parent_id, folder.id, nodes)
    siblings = ordered(nodes, parent_id, folder.id)
    if before_folder_id:
        if before_folder_id == folder.id:
            fail("INVALID_FOLDER_ORDER", "Нельзя поставить папку перед самой собой")
        before = ctx.get(m.Folder, before_folder_id, archived=False)
        if before.parent_id != parent_id:
            fail("INVALID_FOLDER_ORDER", "Папка для порядка должна находиться в выбранном разделе")
        index = next(i for i, f in enumerate(siblings) if f.id == before.id)
        siblings.insert(index, folder)
    else:
        siblings.append(folder)
    previous_parent = folder.parent_id
    moved = previous_parent != parent_id
    folder.parent_id = parent_id
    for position, item in enumerate(siblings):
        if item.position != position or (item.id == folder.id and moved):
            item.position = position
            item.version += 1
    ctx.audit(
        "folder.moved",
        folder.id,
        {"from_parent_id": previous_parent, "parent_id": parent_id, "before_folder_id": before_folder_id},
    )


@operation("use_cases:write", "tester", write=True)
def move_folder(
    ctx,
    folder_id: str,
    expected_version: int,
    parent_id: str | None = None,
    before_folder_id: str | None = None,
):
    """Переместить всю ветку в parent_id (null — корень); before_folder_id задаёт место среди прямых соседей, без него — в конец. Кейсы и их публикации остаются в своих папках."""
    ctx = scoped(ctx)
    folder = ctx.get(m.Folder, folder_id, archived=False)
    ctx.expect(folder, expected_version)
    apply_move(ctx, folder, parent_id, before_folder_id)
    return data_for(ctx, folder)


@operation("use_cases:write", "tester", write=True)
def rename_folder(ctx, folder_id: str, expected_version: int, name: Name):
    """Переименовать папку, сохранив её положение и вложенность."""
    ctx = scoped(ctx)
    folder = ctx.get(m.Folder, folder_id, archived=False)
    ctx.expect(folder, expected_version)
    previous = folder.name
    if previous != clean_name(name):
        folder.name = clean_name(name)
        folder.version += 1
        ctx.audit("folder.renamed", folder.id, {"before": previous, "name": folder.name})
    return data_for(ctx, folder)


@operation("use_cases:write", "tester", write=True)
def update_folder(ctx, folder_id: str, expected_version: int, name: Name, parent_id: str | None = None):
    """Совместимые полные настройки: name и parent_id (null — корень). Для одного переименования используйте rename_folder, для перемещения — move_folder."""
    ctx = scoped(ctx)
    folder = ctx.get(m.Folder, folder_id, archived=False)
    ctx.expect(folder, expected_version)
    name = clean_name(name)
    if folder.parent_id != parent_id:
        apply_move(ctx, folder, parent_id)
    if folder.name != name:
        folder.name = name
        if folder.version == expected_version:
            folder.version += 1
        ctx.audit("folder.renamed", folder.id, {"name": name})
    return data_for(ctx, folder)


@operation("use_cases:write", "tester", write=True)
def delete_folder(
    ctx,
    folder_id: str,
    expected_version: int,
    destination: Literal["parent", "root", "folder"] = "parent",
    destination_folder_id: str | None = None,
):
    """Удалить только папку, сохранив всё содержимое: прямые кейсы (включая архивные) и активные подпапки переносятся на уровень выше, в корень либо выбранную папку. Сама папка попадает в удалённые; история/публикации не удаляются. Действие атомарно."""
    ctx = scoped(ctx)
    folder = ctx.get(m.Folder, folder_id, archived=False)
    ctx.expect(folder, expected_version)
    if (destination == "folder") != bool(destination_folder_id):
        fail(
            "FOLDER_DESTINATION_REQUIRED",
            "Для destination=folder укажите destination_folder_id; иначе не передавайте его",
        )
    target = (
        folder.parent_id
        if destination == "parent"
        else destination_folder_id
        if destination == "folder"
        else None
    )
    nodes = folder_nodes(ctx)
    validate_parent(ctx, target, folder.id, nodes, enforce_depth=False)
    children = ordered(nodes, folder.id)
    for child in children:
        validate_parent(ctx, target, child.id, nodes)
    cases = list(
        ctx.db.scalars(
            select(ctx.item_model).where(
                ctx.item_model.project_id == ctx.project_id, ctx.item_model.folder_id == folder.id
            )
        )
    )
    position = append_position(nodes, target)
    for child in children:
        child.parent_id, child.position = target, position
        child.version += 1
        position += 1
        ctx.audit("folder.moved", child.id, {"from_parent_id": folder.id, "parent_id": target})
    for case in cases:
        case.folder_id = target
        case.version += 1
        ctx.audit(ctx.item_event + ".moved", case.id, {"from_folder_id": folder.id, "folder_id": target})
    folder.archived = True
    folder.version += 1
    ctx.audit(
        "folder.deleted",
        folder.id,
        {
            "destination_id": target,
            ("moved_specifications" if ctx.folder_kind == "specifications" else "moved_use_cases"): len(
                cases
            ),
            "moved_folders": len(children),
        },
    )
    return {
        **data_for(ctx, folder),
        "destination_id": target,
        "moved_items": len(cases),
        ("moved_specifications" if ctx.folder_kind == "specifications" else "moved_use_cases"): len(cases),
        "moved_folders": len(children),
    }


@operation("use_cases:write", "tester", write=True)
def restore_folder(ctx, folder_id: str, expected_version: int, parent_id: str | None = None):
    """Восстановить удалённую папку в корень или parent_id. Ранее перенесённое содержимое остаётся на месте."""
    ctx = scoped(ctx)
    folder = ctx.get(m.Folder, folder_id)
    ctx.expect(folder, expected_version)
    if not folder.archived:
        fail("FOLDER_NOT_DELETED", "Папка уже находится в библиотеке", 409)
    validate_parent(ctx, parent_id, folder.id)
    folder.parent_id = parent_id
    folder.position = append_position(folder_nodes(ctx), parent_id)
    folder.archived = False
    folder.version += 1
    ctx.audit("folder.restored", folder.id, {"parent_id": parent_id})
    return data_for(ctx, folder)


@operation("use_cases:write", "tester", write=True)
def archive_folder(ctx, object_id: str, expected_version: int, archived: bool = True):
    """Совместимый архив: только пустая папка; для удаления с сохранением содержимого используйте delete_folder. Восстановление сохраняет активного родителя, иначе переносит в корень."""
    ctx = scoped(ctx)
    folder = ctx.get(m.Folder, object_id)
    ctx.expect(folder, expected_version)
    if folder.archived == archived:
        return data_for(ctx, folder)
    if not archived:
        parent = ctx.db.get(m.Folder, folder.parent_id) if folder.parent_id else None
        return restore_folder(
            ctx, folder.id, expected_version, parent.id if parent and not parent.archived else None
        )
    nodes = folder_nodes(ctx)
    active_case = ctx.db.scalar(
        select(m.UseCase.id)
        .where(
            m.UseCase.project_id == ctx.project_id,
            m.UseCase.folder_id == folder.id,
            m.UseCase.archived == False,
        )
        .limit(1)
    )
    if ordered(nodes, folder.id) or active_case:
        fail("FOLDER_NOT_EMPTY", "Используйте delete_folder: содержимое будет сохранено и перенесено", 409)
    folder.archived = True
    folder.version += 1
    ctx.audit("folders.archived", folder.id)
    return data_for(ctx, folder)


@operation()
def list_specification_folders(
    ctx,
    archived: bool = False,
    search: Search = "",
    parent_id: str | None = None,
    roots_only: bool = False,
    exclude_subtree_id: str | None = None,
    limit: Limit = 1000,
    offset: Offset = 0,
):
    """Независимое дерево спецификаций: полный path, поиск по пути, пагинация, item_count/archived_item_count/total_item_count, subfolder_count. Для прямых детей — parent_id; для корня — roots_only; exclude_subtree_id исключает ветку."""
    return list_folders(
        FolderContext(ctx, "specifications"),
        archived,
        search,
        parent_id,
        roots_only,
        exclude_subtree_id,
        limit,
        offset,
    )


@operation()
def get_specification_folder(ctx, folder_id: str):
    """Папка спецификаций: актуальная версия, полный путь, прямые и вложенные счётчики; также доступна удалённая папка."""
    return get_folder(FolderContext(ctx, "specifications"), folder_id)


@operation("specifications:write", "tester", write=True)
def create_specification_folder(ctx, name: Name, parent_id: str | None = None):
    """Создать папку спецификаций в корне или parent_id. Папки кейсов не подходят. До 32 уровней."""
    return create_folder(FolderContext(ctx, "specifications"), name, parent_id)


@operation("specifications:write", "tester", write=True)
def rename_specification_folder(ctx, folder_id: str, expected_version: int, name: Name):
    """Переименовать папку спецификаций, сохранив её место и вложенность."""
    return rename_folder(FolderContext(ctx, "specifications"), folder_id, expected_version, name)


@operation("specifications:write", "tester", write=True)
def move_specification_folder(
    ctx,
    folder_id: str,
    expected_version: int,
    parent_id: str | None = None,
    before_folder_id: str | None = None,
):
    """Переместить ветку спецификаций: parent_id=null — корень, before_folder_id — порядок среди соседей. Циклы и чужие разделы запрещены."""
    return move_folder(
        FolderContext(ctx, "specifications"), folder_id, expected_version, parent_id, before_folder_id
    )


@operation("specifications:write", "tester", write=True)
def delete_specification_folder(
    ctx,
    folder_id: str,
    expected_version: int,
    destination: Literal["parent", "root", "folder"] = "parent",
    destination_folder_id: str | None = None,
):
    """Удалить только папку. Прямые спецификации, включая архивные, и активные подпапки переносятся на уровень выше, в корень или выбранную папку спецификаций. Ревизии и связи с кейсами сохраняются. Возвращает destination_id/moved_specifications/moved_folders."""
    return delete_folder(
        FolderContext(ctx, "specifications"), folder_id, expected_version, destination, destination_folder_id
    )


@operation("specifications:write", "tester", write=True)
def restore_specification_folder(ctx, folder_id: str, expected_version: int, parent_id: str | None = None):
    """Восстановить контейнер спецификаций; ранее перенесённое содержимое остаётся на месте."""
    return restore_folder(FolderContext(ctx, "specifications"), folder_id, expected_version, parent_id)
