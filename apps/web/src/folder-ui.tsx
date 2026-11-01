import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Move,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { action } from "./api";
import { useProject } from "./context";
import type { Folder as FolderType } from "./types";
import { SearchPicker } from "./pickers";
import {
  Button,
  Dialog,
  ErrorState,
  Field,
  Form,
  Loading,
  useLoad,
  useToast,
} from "./ui";

export type FolderKind = "use_cases" | "specifications";
const FolderScope = createContext<FolderKind>("use_cases");
export function FolderScopeProvider({
  kind,
  children,
}: {
  kind: FolderKind;
  children: ReactNode;
}) {
  return <FolderScope.Provider value={kind}>{children}</FolderScope.Provider>;
}
const folderAction = (name: string, kind: FolderKind) =>
  kind === "specifications"
    ? name.replace(/_folder(s)?$/, "_specification_folder$1")
    : name;
function useFolderScope() {
  const kind = useContext(FolderScope);
  return {
    kind,
    tool: (name: string) => folderAction(name, kind),
    subject: kind === "specifications" ? "спецификации" : "кейсы",
  };
}

type FolderPage = {
  items: FolderType[];
  total: number;
  next_offset: number | null;
};
export const folderPath = (folder: FolderType) =>
  folder.path.map((p) => p.name).join(" / ");
export async function folderIndex(
  projectId: string,
  archived = false,
  kind: FolderKind = "use_cases",
) {
  const items: FolderType[] = [];
  let offset = 0;
  while (true) {
    const page = await action<FolderPage>(
      folderAction("list_folders", kind),
      projectId,
      {
        archived,
        offset,
        limit: 1000,
      },
    );
    items.push(...page.items);
    if (page.next_offset === null) return { items };
    offset = page.next_offset;
  }
}

export function FolderPicker({
  value,
  onChange,
  label = "Куда переместить",
  rootLabel = "Корень проекта",
  exclude,
  known,
  library = false,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  rootLabel?: string;
  exclude?: string;
  known?: FolderType;
  library?: boolean;
}) {
  const { project } = useProject();
  const { kind, tool } = useFolderScope();
  const selected = useLoad(
    async () =>
      value && value !== "none"
        ? known?.id === value
          ? known
          : action<FolderType>(tool("get_folder"), project.id, {
              folder_id: value,
            })
        : null,
    [project.id, value, known?.version],
  );
  const specials = [
    { id: "", label: rootLabel },
    ...(library ? [{ id: "none", label: "Без папки" }] : []),
  ];
  return (
    <SearchPicker
      key={project.id + ":" + kind + ":" + exclude}
      label={label}
      multiple={false}
      canRemove={!!value}
      values={[
        specials.find((s) => s.id === value) || {
          id: value,
          label: selected.data ? folderPath(selected.data) : "Загружаем путь…",
        },
      ]}
      onChange={(v) => onChange(v[0]?.id || "")}
      placeholder="Найти папку по названию или пути…"
      loadOptions={async (search, offset) => {
        const page = await action<FolderPage>(
          tool("list_folders"),
          project.id,
          {
            search,
            offset,
            limit: 30,
            exclude_subtree_id: exclude || null,
          },
        );
        const extra =
          offset === 0
            ? specials.filter(
                (s) =>
                  !search ||
                  s.label
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase()),
              )
            : [];
        return {
          ...page,
          items: [
            ...extra,
            ...page.items.map((f) => ({
              id: f.id,
              label: f.name,
              detail: folderPath(f),
            })),
          ],
        };
      }}
    />
  );
}

export type FolderTask = {
  mode: "create" | "rename" | "move" | "delete" | "restore";
  folder?: FolderType;
  parent?: FolderType;
};
const taskTitles = {
  create: "Новая папка",
  rename: "Переименовать папку",
  move: "Переместить папку",
  delete: "Удалить папку",
  restore: "Восстановить папку",
};
export function FolderDialog({
  task,
  close,
  saved,
}: {
  task: FolderTask;
  close: () => void;
  saved: (id: string) => void;
}) {
  const { project } = useProject(),
    toast = useToast();
  const { kind, tool, subject } = useFolderScope();
  const { folder, mode } = task;
  const [name, setName] = useState(mode === "create" ? "" : folder?.name || "");
  const [parent, setParent] = useState(
    mode === "create"
      ? task.parent?.id || ""
      : mode === "restore"
        ? ""
        : folder?.parent_id || "",
  );
  const [destination, setDestination] = useState("parent");
  const info = useLoad(
    async () =>
      folder
        ? action<FolderType>(tool("get_folder"), project.id, {
            folder_id: folder.id,
          })
        : null,
    [project.id, folder?.id],
  );
  const current = info.data || folder;
  const knownParent = mode === "create" ? task.parent : undefined;
  return (
    <Dialog
      title={taskTitles[mode]}
      onClose={close}
      focusField={mode === "create" || mode === "rename"}
    >
      {folder && (
        <p className="folder-dialog-path">
          <Folder size={16} />
          {folderPath(current || folder)}
        </p>
      )}
      <Form
        onSubmit={async () => {
          if (folder && (info.loading || info.error))
            throw new Error(
              "Сначала дождитесь загрузки актуальных данных папки.",
            );
          const args = current
            ? { folder_id: current.id, expected_version: current.version }
            : {};
          let result: FolderType & { destination_id?: string | null };
          if (mode === "create")
            result = await action(tool("create_folder"), project.id, {
              name,
              parent_id: parent || null,
            });
          else if (mode === "rename")
            result = await action(tool("rename_folder"), project.id, {
              ...args,
              name,
            });
          else if (mode === "move" || mode === "restore")
            result = await action(tool(mode + "_folder"), project.id, {
              ...args,
              parent_id: parent || null,
            });
          else
            result = await action(tool("delete_folder"), project.id, {
              ...args,
              destination,
              destination_folder_id:
                destination === "folder" ? parent || null : null,
            });
          close();
          saved(
            mode === "delete" ? result.destination_id || "none" : result.id,
          );
          toast(
            mode === "delete"
              ? "Папка удалена. Содержимое сохранено"
              : mode === "move"
                ? "Папка перемещена вместе с содержимым"
                : "Папка сохранена",
          );
        }}
      >
        {folder && info.loading && <Loading />}
        {info.error && <ErrorState error={info.error} retry={info.reload} />}
        {(mode === "create" || mode === "rename") && (
          <Field label="Название папки">
            <input
              autoFocus
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например, Авторизация"
            />
          </Field>
        )}
        {(mode === "create" || mode === "move" || mode === "restore") && (
          <FolderPicker
            label={
              mode === "create"
                ? "В какой папке создать"
                : "Куда поместить папку"
            }
            value={parent}
            onChange={setParent}
            exclude={folder?.id}
            known={knownParent}
          />
        )}
        {mode === "move" && (
          <p className="muted">
            Все подпапки и {subject} переместятся вместе с папкой. История и
            связи сохранятся.
          </p>
        )}
        {mode === "restore" && (
          <p className="muted">
            Папка вернётся в библиотеку. Содержимое, перенесённое при удалении,
            останется на своём месте.
          </p>
        )}
        {mode === "delete" && (
          <>
            <div className="folder-delete-summary">
              <strong>Удалится только папка</strong>
              <p>
                {subject[0].toUpperCase() + subject.slice(1)} и подпапки будут
                перенесены. История и связи сохранятся.
              </p>
              <div className="tags">
                <span className="tag">
                  {kind === "specifications" ? "Спецификаций" : "Кейсов"}:{" "}
                  {current?.item_count || 0}
                </span>
                <span className="tag">
                  В архиве: {current?.archived_item_count || 0}
                </span>
                <span className="tag">
                  Подпапок: {current?.subfolder_count || 0}
                </span>
              </div>
            </div>
            <Field label="Куда перенести содержимое">
              <select
                value={destination}
                onChange={(e) => {
                  setDestination(e.target.value);
                  if (e.target.value === "folder") setParent("");
                }}
              >
                <option value="parent">
                  {folder?.parent_id
                    ? "На уровень выше"
                    : "В корень проекта — " + subject + " без папки"}
                </option>
                {folder?.parent_id && (
                  <option value="root">
                    В корень проекта — {subject} без папки
                  </option>
                )}
                <option value="folder">В другую папку…</option>
              </select>
            </Field>
            {destination === "folder" && (
              <FolderPicker
                label="Папка для содержимого"
                value={parent}
                onChange={setParent}
                exclude={folder?.id}
                rootLabel="Выберите папку"
              />
            )}
            <small className="muted">
              Удалённую папку можно восстановить из раздела «Удалённые папки».
            </small>
          </>
        )}
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button
            type="submit"
            variant={mode === "delete" ? "danger" : "primary"}
            disabled={
              (!!folder && (info.loading || !!info.error)) ||
              (mode === "delete" && destination === "folder" && !parent)
            }
          >
            {mode === "delete"
              ? "Удалить папку"
              : mode === "move"
                ? "Переместить"
                : mode === "restore"
                  ? "Восстановить"
                  : "Сохранить"}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

export function FolderMenu({
  folder,
  onTask,
  folders = [],
  onReordered,
}: {
  folder: FolderType;
  onTask: (task: FolderTask) => void;
  folders?: FolderType[];
  onReordered?: () => void;
}) {
  const { project } = useProject(),
    toast = useToast();
  const { tool } = useFolderScope();
  const [reordering, setReordering] = useState(false);
  const siblings = folders.filter((f) => f.parent_id === folder.parent_id);
  const index = siblings.findIndex((f) => f.id === folder.id);
  async function reorder(direction: number) {
    setPosition(null);
    button.current?.focus();
    setReordering(true);
    try {
      await action(tool("move_folder"), project.id, {
        folder_id: folder.id,
        expected_version: folder.version,
        parent_id: folder.parent_id,
        before_folder_id:
          direction < 0
            ? siblings[index - 1].id
            : siblings[index + 2]?.id || null,
      });
      onReordered?.();
      toast("Порядок папок изменён");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setReordering(false);
    }
  }
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => {
      if (
        event.type === "resize" ||
        (event.type === "scroll" &&
          !(
            event.target instanceof Node && menu.current?.contains(event.target)
          )) ||
        (event.type === "pointerdown" &&
          event.target instanceof Node &&
          !menu.current?.contains(event.target) &&
          !button.current?.contains(event.target))
      )
        setPosition(null);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);
  const entries = [
    { mode: "create" as const, text: "Создать подпапку", icon: FolderPlus },
    { mode: "rename" as const, text: "Переименовать", icon: Pencil },
    { mode: "move" as const, text: "Переместить…", icon: Move },
    { mode: "delete" as const, text: "Удалить папку…", icon: Trash2 },
  ];
  return (
    <>
      <button
        ref={button}
        className="icon-button folder-more"
        disabled={reordering}
        aria-label={"Действия с папкой «" + folder.name + "»"}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={() => {
          const rect = button.current!.getBoundingClientRect();
          setPosition(
            position
              ? null
              : {
                  top: Math.max(
                    8,
                    Math.min(rect.bottom + 5, window.innerHeight - 275),
                  ),
                  left: Math.max(
                    8,
                    Math.min(rect.left, window.innerWidth - 225),
                  ),
                },
          );
        }}
      >
        <MoreHorizontal size={17} />
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            className="folder-menu"
            role="menu"
            aria-label={"Папка «" + folder.name + "»"}
            style={position}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Tab") {
                setPosition(null);
                if (e.key === "Escape") {
                  e.preventDefault();
                  button.current?.focus();
                }
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const buttons = [
                  ...menu.current!.querySelectorAll<HTMLButtonElement>(
                    "button",
                  ),
                ];
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                buttons[
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length
                ]?.focus();
              }
            }}
          >
            {onReordered && index > 0 && (
              <button role="menuitem" onClick={() => void reorder(-1)}>
                <ArrowUp size={16} />
                Выше в списке
              </button>
            )}
            {onReordered && index >= 0 && index < siblings.length - 1 && (
              <button role="menuitem" onClick={() => void reorder(1)}>
                <ArrowDown size={16} />
                Ниже в списке
              </button>
            )}
            {entries.map((item) => (
              <button
                role="menuitem"
                className={item.mode === "delete" ? "danger-text" : ""}
                key={item.mode}
                onClick={() => {
                  setPosition(null);
                  button.current?.focus();
                  onTask(
                    item.mode === "create"
                      ? { mode: "create", parent: folder }
                      : { mode: item.mode, folder },
                  );
                }}
              >
                <item.icon size={16} />
                {item.text}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

const DRAG_TYPE = "application/x-ucaselab-folder";
export function FolderTree({
  folders,
  selected,
  onSelect,
  onTask,
  onMoved,
  qa,
}: {
  folders: FolderType[];
  selected: string;
  onSelect: (id: string) => void;
  onTask: (task: FolderTask) => void;
  onMoved: (id: string) => void;
  qa: boolean;
}) {
  const { project } = useProject(),
    toast = useToast();
  const { kind, tool, subject } = useFolderScope();
  const [query, setQuery] = useState(""),
    [dragged, setDragged] = useState<string | null>(null),
    [over, setOver] = useState<string | null>(null),
    [moving, setMoving] = useState(false);
  const key =
    "ucaselab:folders:" +
    project.id +
    (kind === "specifications" ? ":specifications" : "");
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify([...closed]));
    } catch {
      /* Private mode still supports the tree. */
    }
  }, [key, closed]);
  const selectedPath =
    folders
      .find((f) => f.id === selected)
      ?.path.map((p) => p.id)
      .join() || "";
  useEffect(() => {
    setClosed(
      (s) =>
        new Set(
          [...s].filter(
            (id) => !selectedPath.split(",").slice(0, -1).includes(id),
          ),
        ),
    );
  }, [selectedPath]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const valid = (source: string | null, target: string | null) =>
    !!source &&
    source !== target &&
    !(target && byId.get(target)?.path.some((p) => p.id === source));
  function dragOver(e: DragEvent, target: string | null) {
    if (
      qa &&
      !moving &&
      e.dataTransfer.types.includes(DRAG_TYPE) &&
      valid(dragged, target)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(target || "root");
    }
  }
  async function drop(e: DragEvent, target: string | null) {
    e.preventDefault();
    setOver(null);
    if (!qa || moving) return;
    try {
      const payload = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
      const source = byId.get(payload.id);
      if (
        payload.project_id !== project.id ||
        !source ||
        !valid(source.id, target)
      )
        return;
      setMoving(true);
      await action(tool("move_folder"), project.id, {
        folder_id: source.id,
        expected_version: source.version,
        parent_id: target,
      });
      setClosed((s) => new Set([...s].filter((id) => id !== target)));
      onMoved(source.id);
      toast("Папка перемещена вместе с содержимым");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setMoving(false);
      setDragged(null);
    }
  }
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = folders.filter((f) =>
    words.every((w) => folderPath(f).toLocaleLowerCase().includes(w)),
  );
  function row(f: FolderType, depth: number, flat = false) {
    const children = folders.filter((c) => c.parent_id === f.id);
    const collapsed = closed.has(f.id);
    return (
      <li key={f.id}>
        <div
          className={
            "folder-row " +
            (selected === f.id ? "active " : "") +
            (over === f.id ? "drop-target " : "") +
            (dragged === f.id ? "dragging" : "")
          }
          style={{ paddingLeft: Math.min(depth, 6) * 14 }}
          onDragOver={(e) => dragOver(e, f.id)}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => void drop(e, f.id)}
        >
          {!flat && children.length > 0 ? (
            <button
              className="folder-toggle"
              aria-label={(collapsed ? "Развернуть " : "Свернуть ") + f.name}
              aria-expanded={!collapsed}
              onClick={() =>
                setClosed((s) => {
                  const n = new Set(s);
                  n.has(f.id) ? n.delete(f.id) : n.add(f.id);
                  return n;
                })
              }
            >
              {collapsed ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
            </button>
          ) : (
            <span className="folder-toggle-spacer" />
          )}
          <button
            className="folder-select"
            title={folderPath(f)}
            draggable={qa && !moving}
            onDragStart={(e) => {
              e.dataTransfer.setData(
                DRAG_TYPE,
                JSON.stringify({ id: f.id, project_id: project.id }),
              );
              e.dataTransfer.effectAllowed = "move";
              setDragged(f.id);
            }}
            onDragEnd={() => {
              setDragged(null);
              setOver(null);
            }}
            onClick={() => onSelect(f.id)}
            aria-current={selected === f.id ? "page" : undefined}
          >
            <Folder size={15} />
            <span>
              {f.name}
              {flat && f.parent_id && <small>{folderPath(f)}</small>}
            </span>
            <small
              className="folder-count"
              title={
                (kind === "specifications" ? "Спецификаций" : "Кейсов") +
                ", включая подпапки"
              }
            >
              {f.total_item_count || ""}
            </small>
          </button>
          {qa && (
            <FolderMenu
              folder={f}
              folders={folders}
              onTask={onTask}
              onReordered={() => onMoved(f.id)}
            />
          )}
        </div>
        {!flat && !collapsed && children.length > 0 && (
          <ul>{children.map((c) => row(c, depth + 1))}</ul>
        )}
      </li>
    );
  }
  return (
    <div className="folder-tree" aria-busy={moving}>
      <div
        className={"folder-root-drop " + (over === "root" ? "drop-target" : "")}
        onDragOver={(e) => dragOver(e, null)}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => void drop(e, null)}
      >
        {dragged ? "Перенесите сюда в корень проекта" : "ПАПКИ"}
      </div>
      <label className="folder-search">
        <Search size={14} />
        <input
          aria-label="Найти папку"
          placeholder="Найти папку…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <ul aria-label="Папки проекта">
        {words.length
          ? matches.map((f) => row(f, 0, true))
          : folders.filter((f) => !f.parent_id).map((f) => row(f, 0))}
      </ul>
      {!matches.length && (
        <p className="folder-hint">
          {query
            ? "Папки не найдены"
            : "Группируйте " +
              subject +
              " по разделам. Внутри можно добавить подпапки."}
        </p>
      )}
      {moving && (
        <p role="status" className="folder-hint">
          Перемещаем папку…
        </p>
      )}
    </div>
  );
}

export function DeletedFolders({
  close,
  onRestore,
}: {
  close: () => void;
  onRestore: (folder: FolderType) => void;
}) {
  const { project } = useProject();
  const { kind, subject } = useFolderScope();
  const [search, setSearch] = useState("");
  const data = useLoad(() => folderIndex(project.id, true, kind), [project.id]);
  const items =
    data.data?.items.filter((f) =>
      folderPath(f).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) || [];
  return (
    <Dialog title="Удалённые папки" onClose={close}>
      <p className="muted">
        Восстановите нужную папку. Перенесённые при удалении {subject} и
        подпапки останутся на месте.
      </p>
      <Field label="Найти папку">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Название или прежний путь"
        />
      </Field>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : items.length ? (
        <ul className="deleted-folders">
          {items.map((f) => (
            <li key={f.id}>
              <Folder size={18} />
              <span>
                <strong>{f.name}</strong>
                <small>{folderPath(f)}</small>
              </span>
              <Button
                variant="secondary"
                aria-label={"Восстановить «" + f.name + "»"}
                onClick={() => {
                  close();
                  onRestore(f);
                }}
              >
                <RotateCcw size={15} />
                Восстановить
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="folder-empty">
          {search ? "Ничего не найдено" : "Удалённых папок пока нет"}
        </p>
      )}
    </Dialog>
  );
}
