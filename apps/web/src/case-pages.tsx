import {
  CommentsPanel,
  DiscussionButton,
  DiscussionTrigger,
} from "./discussions";
import { CaseSourceField } from "./run-preparation";
import { caseVersion, type CaseSource } from "./types";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import Markdown from "react-markdown";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCompareArrows,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  Upload,
  RotateCcw,
  Archive,
  Download,
  X,
} from "lucide-react";
import { action } from "./api";
import { LabelPicker } from "./pickers";
import {
  DeletedFolders,
  FolderDialog,
  FolderMenu,
  FolderPicker,
  FolderTree,
  folderIndex,
  folderPath,
} from "./folder-ui";
import type { FolderTask } from "./folder-ui";
import { useProject } from "./context";
import type {
  Anchor,
  CaseContent,
  Environment,
  UseCase,
  Variant,
} from "./types";
import { CaseEditor } from "./case-editor";
import {
  NoMatches,
  hasCatalogFilters,
  CatalogToolbar,
  CatalogPagination,
  useDebounced,
  AsyncButton,
  quantity,
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorState,
  Field,
  Form,
  Loading,
  PageHead,
  Tabs,
  date,
  useLoad,
  useToast,
} from "./ui";

export function CasesPage() {
  const { project } = useProject(),
    navigate = useNavigate(),
    [params, setParams] = useSearchParams();
  const folderId = params.get("folder") || "",
    search = params.get("q") || "",
    page = Math.max(0, Number(params.get("page")) || 0);
  const nestedParam = params.get("nested");
  const [includeSubfolders, setIncludeSubfolders] = useState(
    nestedParam !== "0",
  );
  useEffect(() => setIncludeSubfolders(nestedParam !== "0"), [nestedParam]);
  const archive = params.get("archive") === "1",
    status = params.get("status") || "all";
  const [filters, setFilters] = useState(false);
  const filtersId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const chipButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const chips: { id: string; key: string; value: string; label: string }[] = [];
  function addChip(key: string, value: string, label: string) {
    if (value)
      chips.push({ id: JSON.stringify([key, value]), key, value, label });
  }
  addChip("q", search, `Поиск: «${search}»`);
  if (status !== "all") {
    const labels: Record<string, string> = {
      published: "Опубликованные",
      draft: "С черновиками",
    };
    addChip(
      "status",
      status,
      `Статус: ${Object.hasOwn(labels, status) ? labels[status] : status}`,
    );
  }
  const tags = [...new Set(params.getAll("tag").filter(Boolean))],
    platforms = [...new Set(params.getAll("platform").filter(Boolean))];
  for (const value of tags)
    addChip("tag", value, `Тег: ${value}`);
  for (const value of platforms)
    addChip("platform", value, `Платформа: ${value}`);
  const priority = params.get("priority") || "";
  const priorityLabels: Record<string, string> = {
    critical: "Критический",
    high: "Высокий",
    normal: "Обычный",
    low: "Низкий",
  };
  addChip(
    "priority",
    priority,
    `Приоритет: ${Object.hasOwn(priorityLabels, priority) ? priorityLabels[priority] : priority}`,
  );
  const advancedCount = chips.filter((c) =>
    ["tag", "platform", "priority"].includes(c.key),
  ).length;
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const target =
      chipButtons.current.get(pendingFocus.current) || searchInput.current;
    pendingFocus.current = null;
    target?.focus();
  }, [params]);
  function removeChip(index: number) {
    const chip = chips[index];
    pendingFocus.current = chips[index + 1]?.id || chips[index - 1]?.id || "";
    const next = new URLSearchParams(params);
    if (chip.key === "tag" || chip.key === "platform")
      next.delete(chip.key, chip.value);
    else next.delete(chip.key);
    next.delete("page");
    setParams(next);
  }
  function resetFilters() {
    pendingFocus.current = "";
    const next = new URLSearchParams(params);
    ["q", "status", "tag", "platform", "priority", "page"].forEach((key) =>
      next.delete(key),
    );
    setParams(next);
  }
  const debouncedSearch = useDebounced(search);
  const [create, setCreate] = useState(false),
    [folderDialog, setFolderDialog] = useState<FolderTask | null>(null),
    [deletedFolders, setDeletedFolders] = useState(false);
  const library = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const libraryKey = `ucaselab:library:${project.id}`;
  const qa = project.role !== "developer";
  const cases = useLoad(
    () =>
      action<{
        items: UseCase[];
        total: number;
        total_project: number;
        folder_counts: Record<string, number>;
      }>("list_use_cases", project.id, {
        archived: archive,
        folder_id: folderId && folderId !== "none" ? folderId : null,
        without_folder: folderId === "none",
        include_subfolders: includeSubfolders,
        search: debouncedSearch,
        status,
        sort: params.get("sort") || "created_desc",
        tags: params.getAll("tag"),
        platforms: params.getAll("platform"),
        priority: params.get("priority") || null,
        limit: 50,
        offset: page * 50,
      }),
    [
      project.id,
      archive,
      folderId,
      includeSubfolders,
      debouncedSearch,
      status,
      page,
      params.get("sort"),
      params.getAll("tag").join(),
      params.getAll("platform").join(),
      params.get("priority"),
    ],
  );
  const folders = useLoad(() => folderIndex(project.id), [project.id]);
  useEffect(() => {
    if (cases.loading || !library.current) return;
    const url = location.pathname + location.search;
    try {
      const previous = JSON.parse(sessionStorage.getItem(libraryKey) || "null");
      library.current.scrollTop =
        previous?.url === url ? previous.scroll || 0 : 0;
      sessionStorage.setItem(
        libraryKey,
        JSON.stringify({ url, scroll: library.current.scrollTop }),
      );
    } catch {
      /* Browsing remains usable with browser storage disabled. */
    }
  }, [cases.loading, location.pathname, location.search, libraryKey]);
  const current = folders.data?.items.find((f) => f.id === folderId);
  const filtered = cases.data?.items || [];
  function folderLink(id: string) {
    setParams((p) => {
      id ? p.set("folder", id) : p.delete("folder");
      p.delete("page");
      return p;
    });
  }
  return (
    <div className={"cases-layout case-library " + (cases.data?.total_project ? "populated-library" : "")}>
      <aside className="folders">
        <div className="folder-head">
          <span>Библиотека</span>
          {qa && (
            <button
              className="icon-button"
              aria-label="Создать папку"
              onClick={() => setFolderDialog({ mode: "create" })}
            >
              <FolderPlus size={16} />
            </button>
          )}
        </div>
        <button
          className={"folder-link " + (!folderId ? "active" : "")}
          onClick={() => folderLink("")}
        >
          <FolderOpen size={16} />
          <span>Все юзер-кейсы</span>
          <small>{cases.data?.total_project || 0}</small>
        </button>
        <button
          className={"folder-link " + (folderId === "none" ? "active" : "")}
          onClick={() => folderLink("none")}
        >
          <Folder size={15} />
          <span>Без папки</span>
        </button>
        {folders.loading ? (
          <Loading />
        ) : folders.error ? (
          <ErrorState error={folders.error} retry={folders.reload} />
        ) : (
          <FolderTree
            key={project.id}
            folders={folders.data?.items || []}
            selected={folderId}
            onSelect={folderLink}
            onTask={setFolderDialog}
            onMoved={(id) => {
              folders.reload();
              cases.reload();
              folderLink(id);
            }}
            qa={qa}
          />
        )}
        <div className="folder-bottom">
          {qa && (
            <button
              className="folder-link"
              onClick={() => setDeletedFolders(true)}
            >
              <Trash2 size={15} />
              <span>Удалённые папки</span>
            </button>
          )}
          <button
            className={"folder-link " + (archive ? "active" : "")}
            onClick={() => {
              setParams((p) => {
                !archive ? p.set("archive", "1") : p.delete("archive");
                p.delete("page");
                return p;
              });
            }}
          >
            <Archive size={15} />
            <span>{archive ? "Выйти из архива" : "Архив кейсов"}</span>
          </button>
        </div>
      </aside>
      <div
        className="cases-main"
        ref={library}
        onScroll={(e) => {
          try {
            sessionStorage.setItem(
              libraryKey,
              JSON.stringify({
                url: location.pathname + location.search,
                scroll: e.currentTarget.scrollTop,
              }),
            );
          } catch {
            /* Optional navigation memory. */
          }
        }}
      >
        <PageHead
          eyebrow={
            <>
              <span className="project-dot" />
              {project.name}
              <ChevronRight size={11} />
              Библиотека
            </>
          }
          title={
            archive
              ? "Архив юзер-кейсов"
              : current?.name ||
                (folderId === "none" ? "Без папки" : "Юзер-кейсы")
          }
          description="Опишите, как работает функция: шаги пользователя, ожидаемый результат и варианты данных."
          actions={
            qa && (
              <>
                <span className="library-desktop-actions">
                {current && (
                  <FolderMenu
                    folder={current}
                    folders={folders.data?.items}
                    onTask={setFolderDialog}
                    onReordered={() => folders.reload()}
                  />
                )}
                <Button
                  variant="secondary"
                  onClick={() =>
                    setFolderDialog({ mode: "create", parent: current })
                  }
                >
                  <FolderPlus size={15} />
                  {current ? "Подпапка" : "Папка"}
                </Button>
                </span>
                <Button onClick={() => setCreate(true)}>
                  <Plus size={16} />
                  Новый юзер-кейс
                </Button>
              </>
            )
          }
        />
        {current && (
          <div className="folder-context">
            <nav aria-label="Путь к папке" className="folder-breadcrumbs">
              <button onClick={() => folderLink("")}>Все кейсы</button>
              {current.path.map((p) => (
                <span key={p.id}>
                  <ChevronRight size={12} />
                  <button
                    onClick={() => folderLink(p.id)}
                    aria-current={p.id === current.id ? "page" : undefined}
                  >
                    {p.name}
                  </button>
                </span>
              ))}
            </nav>
            <label className="folder-nested">
              <input
                type="checkbox"
                checked={includeSubfolders}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setIncludeSubfolders(checked);
                  setParams((p) => {
                    const next = new URLSearchParams(p);
                    checked ? next.delete("nested") : next.set("nested", "0");
                    next.delete("page");
                    return next;
                  });
                }}
              />
              Учитывать подпапки
            </label>
          </div>
        )}
        <CatalogToolbar
          searchRef={searchInput}
          placeholder="Найти по названию, номеру или содержимому…"
          statuses={[
            ["published", "Опубликованные"],
            ...(qa ? [["draft", "С черновиками"] as [string, string]] : []),
          ]}
        >
          <Button
            variant="secondary"
            onClick={() => setFilters((v) => !v)}
            aria-expanded={filters}
            aria-controls={filtersId}
            aria-label={`Фильтры: выбрано ${advancedCount}`}
          >
            <span>Фильтры</span>
            {advancedCount > 0 && <span aria-hidden="true">{advancedCount}</span>}
          </Button>
        </CatalogToolbar>
        {chips.length > 0 && (
          <section
            className="catalog-active-filters"
            aria-label="Активные фильтры"
          >
            <span className="catalog-active-label">Активные фильтры</span>
            {chips.map((chip, index) => (
              <button
                key={chip.id}
                ref={(button) => {
                  if (button) chipButtons.current.set(chip.id, button);
                  else chipButtons.current.delete(chip.id);
                }}
                type="button"
                className="catalog-filter-chip"
                aria-label={`Убрать фильтр: ${chip.label}`}
                onClick={() => removeChip(index)}
              >
                <span>{chip.label}</span>
                <X size={14} aria-hidden="true" />
              </button>
            ))}
            <button
              type="button"
              className="text-link catalog-filter-reset"
              onClick={resetFilters}
            >
              Сбросить поиск и фильтры
            </button>
          </section>
        )}
        <div className="catalog-filters" id={filtersId} hidden={!filters}>
          <LabelPicker
            scope="use_cases"
            label="Теги кейсов"
            values={tags}
            create={false}
            onChange={(v) =>
              setParams((p) => {
                p.delete("tag");
                v.forEach((t) => p.append("tag", t));
                p.delete("page");
                return p;
              })
            }
          />
          <LabelPicker
            scope="platforms"
            label="Платформы"
            values={platforms}
            create={false}
            onChange={(v) =>
              setParams((p) => {
                p.delete("platform");
                v.forEach((t) => p.append("platform", t));
                p.delete("page");
                return p;
              })
            }
          />
          <Field label="Приоритет">
            <select
              value={params.get("priority") || ""}
              onChange={(e) =>
                setParams((p) => {
                  e.target.value
                    ? p.set("priority", e.target.value)
                    : p.delete("priority");
                  p.delete("page");
                  return p;
                })
              }
            >
              <option value="">Любой</option>
              <option value="critical">Критический</option>
              <option value="high">Высокий</option>
              <option value="normal">Обычный</option>
              <option value="low">Низкий</option>
            </select>
          </Field>
        </div>
        <div className="mobile-folder-select">
          <FolderPicker
            library
            label="Папка библиотеки"
            rootLabel="Все юзер-кейсы"
            value={folderId}
            onChange={folderLink}
            known={current}
          />
          <details className="library-mobile-actions">
            <summary>Ещё</summary>
            <div className="stack">
              {qa && <>
                <Button variant="secondary" onClick={() => setFolderDialog({ mode: "create", parent: current })}><FolderPlus size={15} />{current ? "Подпапка" : "Создать папку"}</Button>
                {current && <FolderMenu folder={current} folders={folders.data?.items} onTask={setFolderDialog} onReordered={() => folders.reload()} />}
                <Button variant="secondary" onClick={() => setDeletedFolders(true)}>Удалённые папки</Button>
              </>}
              <Button variant="secondary" onClick={() => setParams((p) => {
                archive ? p.delete("archive") : p.set("archive", "1");
                p.delete("page");
                return p;
              })}>{archive ? "Выйти из архива" : "Архив кейсов"}</Button>
            </div>
          </details>
        </div>
        <div className="panel">
          {cases.loading ? (
            <Loading />
          ) : cases.error ? (
            <ErrorState error={cases.error} retry={cases.reload} />
          ) : !filtered.length ? (
            hasCatalogFilters(params) ? (
              <NoMatches onReset={resetFilters} />
            ) : (
              <Empty
                title={
                  search ? "Ничего не найдено" : "Здесь будут ваши сценарии"
                }
                description={
                  search
                    ? "Попробуйте другой запрос или измените фильтры."
                    : "Начните с одной функции — например, регистрации. Добавьте шаги и данные, с которыми её нужно проверить."
                }
                action={
                  qa &&
                  !search && (
                    <Button onClick={() => setCreate(true)}>
                      <Plus size={15} />
                      Создать юзер-кейс
                    </Button>
                  )
                }
              />
            )
          ) : (
            <div className="table-scroll">
              <table className="data-table cases-table">
                <thead>
                  <tr>
                    <th>Юзер-кейс</th>
                    <th>Статус</th>
                    <th>Приоритет</th>
                    <th>Версия</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="case-title-link" to={`${c.id}`}>
                          <span className="case-icon">
                            <FolderOpen size={17} />
                          </span>
                          <div>
                            <span className="mono case-key">{c.key}</span>
                            <span className="cell-title">{c.title}</span>
                            {c.folder_id && c.folder_id !== current?.id && (
                              <small className="case-folder-path">
                                {folders.data?.items.find(
                                  (f) => f.id === c.folder_id,
                                )
                                  ? folderPath(
                                      folders.data.items.find(
                                        (f) => f.id === c.folder_id,
                                      )!,
                                    )
                                  : ""}
                              </small>
                            )}
                            {c.tags.length > 0 && (
                              <div className="tags">
                                {c.tags.slice(0, 3).map((t) => (
                                  <span className="tag" key={t}>
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </Link>
                      </td>
                      <td>
                        <Badge
                          status={
                            c.current_publication_id ? "published" : "draft"
                          }
                        />
                        {c.current_publication_id &&
                          c.has_unpublished_changes && (
                            <span className="draft-note">Есть изменения</span>
                          )}
                      </td>
                      <td>
                        <span className={"priority " + c.priority}>
                          <i />
                          {
                            (
                              {
                                low: "Низкий",
                                normal: "Обычный",
                                high: "Высокий",
                                critical: "Критический",
                              } as Record<string, string>
                            )[c.priority]
                          }
                        </span>
                      </td>
                      <td>
                        <span className="mono muted">
                          {c.publication_number
                            ? "v" + c.publication_number
                            : "—"}
                        </span>
                      </td>
                      <td>
                        <Link
                          className="icon-button"
                          aria-label={"Открыть " + c.title}
                          to={c.id}
                        >
                          <ChevronRight size={16} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <CatalogPagination total={cases.data?.total || 0} />
      </div>
      {create && (
        <CaseEditor
          key={project.id + ":create"}
          draftId="case:create"
          folderId={current?.id}
          onClose={() => setCreate(false)}
          onSave={async (content, folder_id, message) => {
            const c = await action<UseCase>("create_use_case", project.id, {
              content,
              folder_id,
              message,
            });
            setCreate(false);
            navigate(c.id);
          }}
        />
      )}
      {folderDialog && (
        <FolderDialog
          task={folderDialog}
          close={() => setFolderDialog(null)}
          saved={(id) => {
            folders.reload();
            cases.reload();
            folderLink(id);
          }}
        />
      )}
      {deletedFolders && (
        <DeletedFolders
          close={() => setDeletedFolders(false)}
          onRestore={(folder) => setFolderDialog({ mode: "restore", folder })}
        />
      )}
    </div>
  );
}

export function CasePage() {
  const { project } = useProject(),
    { caseId } = useParams(),
    [params, setParams] = useSearchParams(),
    navigate = useNavigate(),
    toast = useToast();
  const data = useLoad(
    () => action<UseCase>("get_use_case", project.id, { use_case_id: caseId }),
    [project.id, caseId],
  );
  const [edit, setEdit] = useState(false),
    [publish, setPublish] = useState(false),
    [run, setRun] = useState(false),
    [commentsOpen, setComments] = useState(false),
    [anchor, setAnchor] = useState<Anchor | undefined>(),
    [menu, setMenu] = useState(false),
    [copy, setCopy] = useState(false);
  const tab = params.get("tab") || "scenario";
  const c = data.data;
  const selectedThread = params.get("thread");
  const comments = commentsOpen || !!selectedThread;
  const discussionTrigger = useRef<HTMLButtonElement>(null);
  function closeComments() {
    setComments(false);
    if (selectedThread)
      setParams(
        (previous) => {
          previous.delete("thread");
          return previous;
        },
        { replace: true },
      );
  }
  useEffect(() => {
    setAnchor(undefined);
    setComments(false);
  }, [caseId]);
  if (data.loading && !c) return <Loading />;
  if (data.error || !c)
    return <ErrorState error={data.error} retry={data.reload} />;
  const qa = project.role !== "developer";
  let back = `../cases${c.folder_id ? "?folder=" + c.folder_id : ""}`;
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(`ucaselab:library:${project.id}`) || "null",
    );
    if (saved?.url?.startsWith(`/p/${project.id}/cases`)) back = saved.url;
  } catch {
    /* Fall back to the case folder. */
  }
  return (
    <div className="case-page-wrap">
      <div className="page case-page">
        <Link className="back" to={back}>
          <ArrowLeft size={14} />К юзер-кейсам
        </Link>
        <PageHead
          eyebrow={
            <>
              <span className="mono">{c.key}</span>
              <Badge
                status={c.current_publication_id ? "published" : "draft"}
              />
              {c.publication_number && <span>v{c.publication_number}</span>}
              {c.has_unpublished_changes && c.current_publication_id && (
                <span className="draft-note">
                  Есть неопубликованные изменения
                </span>
              )}
            </>
          }
          title={c.title}
          actions={
            <>
              {qa && !c.archived && (
                <>
                  <Button variant="secondary" onClick={() => setEdit(true)}>
                    <Pencil size={14} />
                    Изменить
                  </Button>
                  {c.has_unpublished_changes && (
                    <Button onClick={() => setPublish(true)}>
                      <Upload size={15} />
                      Опубликовать
                    </Button>
                  )}
                </>
              )}
              {!c.archived && qa && (
                <Button variant="secondary" onClick={() => setRun(true)}>
                  <Play size={14} />
                  Проверить
                </Button>
              )}
              <DiscussionTrigger
                buttonRef={discussionTrigger}
                expanded={comments}
                onClick={() => (comments ? closeComments() : setComments(true))}
              />
              <div className="dropdown-wrap">
                <button
                  className="icon-button"
                  aria-label="Другие действия"
                  onClick={() => setMenu((v) => !v)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {menu && (
                  <div className="dropdown">
                    {qa && (
                      <>
                        <button
                          onClick={() => {
                            setMenu(false);
                            setCopy(true);
                          }}
                        >
                          <Copy size={14} />
                          Скопировать
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await action("archive_use_case", project.id, {
                                object_id: c.id,
                                expected_version: c.version,
                                archived: !c.archived,
                              });
                              toast(
                                c.archived
                                  ? "Кейс восстановлен"
                                  : "Кейс в архиве",
                              );
                              data.reload();
                              setMenu(false);
                            } catch (e) {
                              toast((e as Error).message, "error");
                            }
                          }}
                        >
                          <Archive size={14} />
                          {c.archived ? "Восстановить" : "В архив"}
                        </button>
                      </>
                    )}
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(location.href);
                        setMenu(false);
                        toast("Ссылка скопирована");
                      }}
                    >
                      <Copy size={14} />
                      Скопировать ссылку
                    </button>
                  </div>
                )}
              </div>
            </>
          }
        />
        <Tabs
          value={tab}
          onChange={(key) =>
            setParams((p) => {
              key === "scenario" ? p.delete("tab") : p.set("tab", key);
              return p;
            })
          }
          items={[
            { key: "scenario", label: "Сценарий" },
            { key: "executions", label: "Проверки" },
            { key: "proposals", label: "Предложения" },
            { key: "history", label: "История" },
          ]}
        />
        {tab === "scenario" ? (
          <CaseDocument
            content={c.content}
            onComment={(a) => {
              setAnchor({ revision_id: c.revision_id, ...a });
              setComments(true);
            }}
          />
        ) : tab === "history" ? (
          <History case_={c} reload={data.reload} />
        ) : tab === "executions" ? (
          <ExecutionHistory caseId={c.id} />
        ) : (
          <CaseProposals caseId={c.id} />
        )}
      </div>
      {comments && (
        <CommentsPanel
          case_={c}
          anchor={anchor}
          clearAnchor={() => setAnchor(undefined)}
          close={closeComments}
          focusReturnRef={anchor ? undefined : discussionTrigger}
        />
      )}
      {edit && (
        <CaseEditor
          key={project.id + ":edit:" + c.id + ":" + c.revision_id + ":" + c.folder_id}
          draftId={"case:edit:" + c.id}
          revision={c.revision_id}
          initial={c.content}
          folderId={c.folder_id}
          title="Редактирование юзер-кейса"
          onClose={() => setEdit(false)}
          onSave={async (content, folder_id, message) => {
            await action<UseCase>("save_use_case_draft", project.id, {
              use_case_id: c.id,
              expected_version: c.version,
              base_revision_id: c.revision_id,
              content,
              message,
              change_folder: folder_id !== c.folder_id,
              folder_id,
            });
            setEdit(false);
            data.reload();
            toast("Черновик сохранён");
          }}
        />
      )}
      {publish && (
        <PublishDialog
          case_={c}
          close={() => setPublish(false)}
          reload={data.reload}
        />
      )}
      {run && (
        <QuickRun
          defaultSource={c.current_publication_id ? "published" : "draft"}
          caseIds={[c.id]}
          title={"Проверка: " + c.title}
          close={() => setRun(false)}
        />
      )}
      {copy && (
        <NameDialog
          title="Копия юзер-кейса"
          label="Название нового кейса"
          initial={c.title + " — копия"}
          close={() => setCopy(false)}
          submit={async (title) => {
            const result = await action<UseCase>("copy_use_case", project.id, {
              use_case_id: c.id,
              title,
              folder_id: c.folder_id,
            });
            navigate(`../cases/${result.id}`);
            setCopy(false);
          }}
        />
      )}
    </div>
  );
}

export function NameDialog({
  title,
  label,
  initial = "",
  close,
  submit,
}: {
  title: string;
  label: string;
  initial?: string;
  close: () => void;
  submit: (v: string) => Promise<void>;
}) {
  const [value, set] = useState(initial);
  return (
    <Dialog title={title} onClose={close}>
      <Form onSubmit={() => submit(value)}>
        <Field label={label}>
          <input
            autoFocus
            required
            value={value}
            onChange={(e) => set(e.target.value)}
          />
        </Field>
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button type="submit">Сохранить</Button>
        </div>
      </Form>
    </Dialog>
  );
}

function PublishDialog({
  case_: c,
  close,
  reload,
}: {
  case_: UseCase;
  close: () => void;
  reload: () => void;
}) {
  const { project } = useProject();
  const [message, set] = useState("");
  return (
    <Dialog title="Опубликовать версию" onClose={close}>
      <p className="dialog-description">
        После публикации агенты и новые прогоны смогут использовать этот
        сценарий. Уже запущенные проверки сохранят свои версии.
      </p>
      <Form
        onSubmit={async () => {
          await action("publish_use_case", project.id, {
            use_case_id: c.id,
            expected_version: c.version,
            revision_id: c.revision_id,
            message,
          });
          close();
          reload();
        }}
      >
        <Field label="Что вошло в эту версию">
          <textarea
            autoFocus
            required
            value={message}
            onChange={(e) => set(e.target.value)}
            maxLength={240}
            placeholder="Добавлены проверки формата почты и повторной регистрации"
          />
        </Field>
        <div className="form-footer">
          <Button type="submit">
            <Upload size={15} />
            Опубликовать v{(c.publication_number || 0) + 1}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

function QuickRun({
  caseIds,
  title: initial,
  close,
  defaultSource = "published",
}: {
  defaultSource?: CaseSource;
  caseIds: string[];
  title: string;
  close: () => void;
}) {
  const { project } = useProject(),
    navigate = useNavigate();
  const [title, set] = useState(initial),
    [env, setEnv] = useState(""),
    [build, setBuild] = useState(""),
    [caseSource, setCaseSource] = useState<CaseSource>(defaultSource);
  const envs = useLoad(
    () => action<{ items: Environment[] }>("list_environments", project.id),
    [project.id],
  );
  const preview = useLoad(
    () =>
      action<{ count: number; selection_hash: string }>(
        "preview_run",
        project.id,
        {
          use_case_ids: caseIds,
          case_source: caseSource,
          environment_id: env || null,
        },
      ),
    [project.id, caseIds.join(), caseSource, env],
  );
  return (
    <Dialog title="Подготовить проверку" onClose={close}>
      <Form
        onSubmit={async () => {
          if (!preview.data || preview.error || preview.loading)
            throw new Error("Дождитесь состава прогона");
          const run = await action<{ id: string }>("create_run", project.id, {
            title,
            use_case_ids: caseIds,
            environment_id: env || null,
            build,
            case_source: caseSource,
            selection_hash: preview.data.selection_hash,
          });
          close();
          navigate(`/p/${project.id}/runs/${run.id}`);
        }}
      >
        <CaseSourceField value={caseSource} change={setCaseSource} />
        {preview.loading ? (
          <Loading />
        ) : preview.error ? (
          <ErrorState error={preview.error} retry={preview.reload} />
        ) : (
          <p className="field-hint">
            В прогоне будет{" "}
            {quantity(preview.data?.count || 0, [
              "проверка",
              "проверки",
              "проверок",
            ])}{" "}
            по вариантам данных. Перед началом проверьте готовность стенда и
            доступов.
          </p>
        )}
        <Field label="Название прогона">
          <input required value={title} onChange={(e) => set(e.target.value)} />
        </Field>
        <Field label="Окружение">
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="">Не указано</option>
            {envs.data?.items.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Сборка / версия приложения">
          <input
            value={build}
            onChange={(e) => setBuild(e.target.value)}
            placeholder="v1.2.0, commit SHA или номер сборки"
          />
        </Field>
        <div className="form-footer">
          <Button
            type="submit"
            disabled={!preview.data || preview.loading || !!preview.error}
          >
            <ArrowRight size={15} />
            Подготовить прогон
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

export function CaseDocument({
  content,
  onComment,
}: {
  content: CaseContent;
  onComment?: (a: Omit<Anchor, "revision_id">) => void;
}) {
  return (
    <div className="case-reading">
      <dl className="metadata case-properties" aria-label="Свойства кейса">
        <div>
          <dt>Приоритет</dt>
          <dd>
            <span className={"priority " + content.priority}>
              <i />
              {
                (
                  {
                    normal: "Обычный",
                    low: "Низкий",
                    high: "Высокий",
                    critical: "Критический",
                  } as Record<string, string>
                )[content.priority]
              }
            </span>
          </dd>
        </div>
        <div>
          <dt>Теги</dt>
          <dd>
            <div className="tags">
              {content.tags.length
                ? content.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))
                : "Не указаны"}
            </div>
          </dd>
        </div>
        <div>
          <dt>Платформы</dt>
          <dd>
            <div className="tags">
              {content.platforms.length
                ? content.platforms.map((v) => (
                    <span key={v} className="tag">
                      {v}
                    </span>
                  ))
                : "Не указаны"}
            </div>
          </dd>
        </div>
        <RelatedMetadata content={content} />
      </dl>
      <article className="case-document" aria-label="Содержание сценария">
        {content.goal && (
          <section className="section">
            <div className="section-title">
              <h2>Цель сценария</h2>
            </div>
            <div className="prose">
              <Markdown>{content.goal}</Markdown>
            </div>
          </section>
        )}
        {content.preconditions && (
          <section className="section">
            <div className="section-title">
              <h2>Предусловия</h2>
            </div>
            <div className="preconditions prose">
              <Markdown>{content.preconditions}</Markdown>
            </div>
          </section>
        )}
        <section className="section">
          <div className="section-title">
            <h2>
              Шаги прохождения{" "}
              <span className="count">{content.steps.length}</span>
            </h2>
          </div>
          <div className="steps-document">
            <div className="step-columns">
              <span>Действие</span>
              <span>Ожидаемый результат</span>
            </div>
            {content.steps.map((s, i) => (
              <div className="document-step" key={s.key}>
                <span className="step-number">{i + 1}</span>
                <div className="prose">
                  <Markdown>{s.action}</Markdown>
                </div>
                <div className="prose expected">
                  <Markdown>
                    {s.expected || "Ожидаемый результат ещё не описан"}
                  </Markdown>
                </div>
                {onComment && (
                  <button
                    className="icon-button comment-step"
                    title="Обсудить шаг"
                    aria-label={`Обсудить шаг ${i + 1}`}
                    onClick={() =>
                      onComment({
                        field_path: "steps/" + s.key,
                        step_key: s.key,
                        quote: s.action,
                      })
                    }
                  >
                    <MessageSquare size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
        <CaseSpecifications content={content} />
        <VariantTable
          variants={content.variants}
          polarity="positive"
          onComment={onComment}
        />
        <VariantTable
          variants={content.variants}
          polarity="negative"
          onComment={onComment}
        />
        {content.cleanup && (
          <section className="section">
            <div className="section-title">
              <h2>После выполнения</h2>
            </div>
            <div className="prose">
              <Markdown>{content.cleanup}</Markdown>
            </div>
          </section>
        )}
      </article>
    </div>
  );
}
function CaseSpecifications({ content }: { content: CaseContent }) {
  const { project } = useProject();
  const data = useLoad(
    () =>
      Promise.all(
        content.specifications.map((s) =>
          (s.revision_id
            ? action<{ content: { title: string; tags: string[] } }>(
                "get_specification_revision",
                project.id,
                {
                  specification_id: s.specification_id,
                  revision_id: s.revision_id,
                },
              ).then((r) => ({ id: s.specification_id, ...r.content }))
            : action<{ id: string; title: string; tags: string[] }>(
                "get_specification",
                project.id,
                { specification_id: s.specification_id },
              )
          ).catch(() => ({
            id: s.specification_id,
            title: "Недоступная спецификация",
            tags: [],
          })),
        ),
      ),
    [
      project.id,
      content.specifications
        .map((s) => s.specification_id + ":" + s.revision_id)
        .join(),
    ],
  );
  if (!content.specifications.length) return null;
  return (
    <section className="section case-specifications">
      <div className="section-title">
        <h2>
          Спецификации{" "}
          <span className="count">{content.specifications.length}</span>
        </h2>
      </div>
      <div className="reference-chips">
        {content.specifications.map((s) => (
          <Link
            className="reference-chip"
            key={s.specification_id}
            to={`/p/${project.id}/specifications?open=${s.specification_id}${s.revision_id ? "&revision=" + s.revision_id : ""}`}
          >
            <span>
              {data.data?.find((v) => v.id === s.specification_id)?.title ||
                "Загружаем…"}
            </span>
            <ArrowRight size={14} />
          </Link>
        ))}
      </div>
    </section>
  );
}
function RelatedMetadata({ content }: { content: CaseContent }) {
  const { project } = useProject();
  const data = useLoad(
    async () => ({
      accounts: await Promise.all(
        content.accounts.map((a) =>
          action<{ id: string; name: string }>("get_test_account", project.id, {
            account_id: a.account_id,
          }),
        ),
      ),
    }),
    [project.id, content.accounts.map((a) => a.account_id).join()],
  );
  return (
    <>
      <div>
        <dt>Тестовые аккаунты</dt>
        <dd>
          {content.accounts.length
            ? content.accounts.map((a) => (
                <Link
                  className="metadata-link"
                  key={a.account_id}
                  to={`/p/${project.id}/accounts?open=${a.account_id}`}
                >
                  {data.data?.accounts.find((v) => v.id === a.account_id)
                    ?.name || a.alias}
                  <span className="mono">{a.alias}</span>
                </Link>
              ))
            : "Не связаны с кейсом"}
        </dd>
      </div>
    </>
  );
}
function VariantTable({
  variants,
  polarity,
  onComment,
}: {
  variants: Variant[];
  polarity: string;
  onComment?: (a: Omit<Anchor, "revision_id">) => void;
}) {
  const list = variants.filter((v) => v.polarity === polarity);
  return (
    <section className="section">
      <div className="section-title">
        <h2 className="inline">
          <span className={"polarity-dot " + polarity} />
          {polarity === "positive"
            ? "Положительные данные"
            : "Отрицательные данные"}{" "}
          <span className="count">{list.length}</span>
        </h2>
      </div>
      {!list.length ? (
        <div className="quiet-empty">Варианты данных пока не добавлены</div>
      ) : (
        <div className="panel table-scroll">
          <table className="data-table variants-table">
            <thead>
              <tr>
                <th>Вариант и данные</th>
                <th>Ожидаемое поведение</th>
                {onComment && <th />}
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr key={v.key}>
                  <td>
                    <strong>{v.name}</strong>
                    {!v.enabled && <span className="tag">Отключён</span>}
                    <dl className="input-values">
                      {Object.entries(v.inputs).map(([key, val]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>
                            {String(val) === "" ? (
                              <em>пустая строка</em>
                            ) : (
                              String(val)
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {v.steps_override && (
                      <details>
                        <summary>Другой путь прохождения</summary>
                        <ol>
                          {v.steps_override.map((s) => (
                            <li key={s.key}>
                              {s.action} → {s.expected}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </td>
                  <td>
                    <p>{v.expected}</p>
                    {v.notes && <small>{v.notes}</small>}
                  </td>
                  {onComment && (
                    <td>
                      <button
                        className="icon-button"
                        aria-label="Обсудить вариант"
                        onClick={() =>
                          onComment({
                            field_path: "variants/" + v.key,
                            variant_key: v.key,
                            quote: v.name,
                          })
                        }
                      >
                        <MessageSquare size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function History({ case_: c, reload }: { case_: UseCase; reload: () => void }) {
  const { project } = useProject();
  type Revision = {
    id: string;
    number: number;
    message: string;
    author_id: string;
    created_at: string;
  };
  const history = useLoad(
    () =>
      action<{
        revisions: Revision[];
        publications: {
          id: string;
          number: number;
          revision_id: string;
          message: string;
        }[];
      }>("list_use_case_history", project.id, { use_case_id: c.id }),
    [project.id, c.id, c.revision_id],
  );
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(c.revision_id),
    [diff, setDiff] = useState<
      { path: string; kind: string; before: unknown; after: unknown }[] | null
    >(null),
    [preview, setPreview] = useState<CaseContent | null>(null);
  useEffect(() => {
    if (history.data?.revisions.length)
      setFrom(history.data.revisions[1]?.id || history.data.revisions[0].id);
  }, [history.data]);
  if (history.loading) return <Loading />;
  if (history.error)
    return <ErrorState error={history.error} retry={history.reload} />;
  return (
    <div className="stack">
      <div className="panel diff-toolbar">
        <div>
          <h3>Сравнить версии</h3>
          <p>
            Изменения полей, шагов и вариантов данных с сохранением их
            идентичности.
          </p>
        </div>
        <div className="inline">
          <select
            aria-label="Исходная версия"
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {history.data?.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                Ревизия {r.number}
              </option>
            ))}
          </select>
          <ArrowRight size={15} />
          <select
            aria-label="Новая версия"
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            {history.data?.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                Ревизия {r.number}
              </option>
            ))}
          </select>
          <AsyncButton
            disabled={!from || !to}
            variant="secondary"
            onAction={async () => {
              const r = await action<{ changes: typeof diff }>(
                "compare_use_case_revisions",
                project.id,
                {
                  use_case_id: c.id,
                  from_revision_id: from,
                  to_revision_id: to,
                },
              );
              setDiff(r.changes);
            }}
          >
            <GitCompareArrows size={14} />
            Сравнить
          </AsyncButton>
        </div>
      </div>
      {diff && (
        <div className="panel">
          {!diff.length ? (
            <Empty title="Содержимое совпадает" />
          ) : (
            diff.map((d, i) => (
              <div key={i} className="diff-entry">
                <span className="mono">{d.path}</span>
                <span className="tag">
                  {
                    (
                      {
                        moved: "Перемещение",
                        added: "Добавлено",
                        removed: "Удалено",
                        changed: "Изменено",
                      } as Record<string, string>
                    )[d.kind]
                  }
                </span>
                <div className="diff-values">
                  <pre className="before">
                    {typeof d.before === "string"
                      ? d.before
                      : JSON.stringify(d.before, null, 2)}
                  </pre>
                  <pre className="after">
                    {typeof d.after === "string"
                      ? d.after
                      : JSON.stringify(d.after, null, 2)}
                  </pre>
                </div>
              </div>
            ))
          )}
        </div>
      )}
      <div className="panel">
        {history.data?.revisions.map((r) => {
          const pubs = history.data!.publications.filter(
            (p) => p.revision_id === r.id,
          );
          return (
            <div className="list-row" key={r.id}>
              <div className="history-marker">
                <GitCompareArrows size={15} />
              </div>
              <div className="grow">
                <div className="inline">
                  <h3>{r.message || "Изменён сценарий"}</h3>
                  {pubs.map((p) => (
                    <Badge key={p.id} status="published">
                      v{p.number}
                    </Badge>
                  ))}
                  {r.id === c.working_revision_id && (
                    <span className="tag">Рабочая версия</span>
                  )}
                </div>
                <p>
                  Ревизия {r.number} · {date(r.created_at)}
                </p>
              </div>
              <AsyncButton
                variant="ghost"
                onAction={async () => {
                  const v = await action<{ content: CaseContent }>(
                    "get_use_case_revision",
                    project.id,
                    { use_case_id: c.id, revision_id: r.id },
                  );
                  setPreview(v.content);
                }}
              >
                Просмотреть
              </AsyncButton>
              {project.role !== "developer" &&
                r.id !== c.working_revision_id && (
                  <AsyncButton
                    variant="ghost"
                    onAction={async () => {
                      await action("restore_use_case_revision", project.id, {
                        use_case_id: c.id,
                        expected_version: c.version,
                        revision_id: r.id,
                      });
                      reload();
                      history.reload();
                    }}
                  >
                    <RotateCcw size={14} />
                    Восстановить
                  </AsyncButton>
                )}
            </div>
          );
        })}
      </div>
      {preview && (
        <Dialog
          title="Содержимое исторической версии"
          onClose={() => setPreview(null)}
          wide
        >
          <CaseDocument content={preview} />
        </Dialog>
      )}
    </div>
  );
}


type HistoryExecution = {
  id: string;
  status: string;
  actor_name: string;
  created_at: string;
  started_at: string;
  finished_at: string;
  actual_result: string;
  source: string;
  attempt: number;
  publication_number: number | null;
  case_source?: CaseSource;
  revision_number?: number | null;
  is_current_revision?: boolean;
  is_current_publication: boolean;
  variant: Variant | null;
  environment: Partial<Environment>;
  build: string;
  run_id: string;
  run_title: string;
  external_issue_url: string;
  annotations: { id: string; body: string; created_at: string }[];
  attachments: { id: string; filename: string; size: number }[];
};
function ExecutionHistory({ caseId }: { caseId: string }) {
  const { project } = useProject();
  const data = useLoad(
    () =>
      action<{ items: HistoryExecution[] }>(
        "list_use_case_executions",
        project.id,
        { use_case_id: caseId },
      ),
    [project.id, caseId],
  );
  const [selected, setSelected] = useState<HistoryExecution | null>(null),
    [annotation, setAnnotation] = useState("");
  return data.loading ? (
    <Loading />
  ) : data.error ? (
    <ErrorState error={data.error} retry={data.reload} />
  ) : !data.data?.items.length ? (
    <Empty
      title="Сценарий ещё не проверяли"
      description="Нажмите «Проверить», выполните шаги и запишите результат. Здесь будет видно, кто проверял кейс, когда и на каких данных."
    />
  ) : (
    <>
      <div className="note" style={{ marginBottom: 20 }}>
        Результат относится к закреплённой ревизии сценария. Успех предыдущей
        версии не подтверждает текущую.
      </div>
      <div className="panel table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Когда и кто</th>
              <th>Вариант данных</th>
              <th>Версия и окружение</th>
              <th>Результат</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.data.items.map((e) => (
              <tr key={e.id}>
                <td>
                  <strong>{e.actor_name || "Не назначено"}</strong>
                  <p className="muted" style={{ fontSize: 11 }}>
                    {date(e.finished_at || e.started_at)}
                  </p>
                  <small>
                    {e.source === "agent" ? "ИИ-агент" : "Вручную"} · попытка{" "}
                    {e.attempt}
                  </small>
                </td>
                <td>{e.variant?.name || "Основной сценарий"}</td>
                <td>
                  <div className="inline">
                    <span className="mono">{caseVersion(e)}</span>
                    {!(e.case_source === "draft"
                      ? e.is_current_revision
                      : e.is_current_publication) && (
                      <span className="tag">Предыдущая версия</span>
                    )}
                  </div>
                  <small>
                    {e.environment.name || "Окружение не указано"}
                    {e.build && " · " + e.build}
                  </small>
                </td>
                <td>
                  <Badge status={e.status} />
                  <p className="actual-excerpt">{e.actual_result}</p>
                </td>
                <td>
                  <button className="text-link" onClick={() => setSelected(e)}>
                    Подробнее
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <Dialog
          title="Результат проверки"
          onClose={() => setSelected(null)}
          actions={
            <DiscussionButton
              targetType="execution"
              targetId={selected.id}
              followThreadLink={false}
            />
          }
        >
          <div className="stack">
            <div className="inline">
              <Badge status={selected.status} />
              <span className="tag">{caseVersion(selected)}</span>
            </div>
            <p className="prose">
              {selected.actual_result || "Результат ещё не записан"}
            </p>
            <Link
              className="text-link"
              to={`/p/${project.id}/runs/${selected.run_id}`}
            >
              Открыть прогон: {selected.run_title}
            </Link>
            {selected.external_issue_url && (
              <a
                href={selected.external_issue_url}
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                Внешняя задача ↗
              </a>
            )}
            {selected.attachments.map((a) => (
              <a
                key={a.id}
                className="text-link inline"
                href={`/api/projects/${project.id}/attachments/${a.id}`}
              >
                <Download size={13} />
                {a.filename}
              </a>
            ))}
            {selected.annotations.map((a) => (
              <div className="note" key={a.id}>
                {a.body}
                <br />
                <small>{date(a.created_at)}</small>
              </div>
            ))}
            {project.role !== "developer" && (
              <Form
                onSubmit={async () => {
                  await action("add_execution_annotation", project.id, {
                    execution_id: selected.id,
                    body: annotation,
                  });
                  setSelected(null);
                  setAnnotation("");
                  data.reload();
                }}
              >
                <Field
                  label="Дополнительное пояснение"
                  hint="Пояснение добавится к проверке. Записанный ранее результат сохранится."
                >
                  <textarea
                    required
                    value={annotation}
                    onChange={(e) => setAnnotation(e.target.value)}
                  />
                </Field>
                <Button type="submit">Добавить пояснение</Button>
              </Form>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
function CaseProposals({ caseId }: { caseId: string }) {
  const { project } = useProject();
  const data = useLoad(
    () =>
      action<{
        items: {
          id: string;
          title: string;
          status: string;
          created_at: string;
          content: { description: string };
        }[];
      }>("list_proposals", project.id, { use_case_id: caseId }),
    [project.id, caseId],
  );
  return (
    <div className="stack">
      <div className="inline spaced">
        <p className="muted" style={{ fontSize: 12 }}>
          Изменения функционала и идеи, связанные с этим сценарием.
        </p>
        <Link
          to={`/p/${project.id}/proposals?new=1&case=${caseId}`}
          className="button secondary"
        >
          <Plus size={14} />
          Предложить изменение
        </Link>
      </div>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !data.data?.items.length ? (
        <div className="panel">
          <Empty
            title="Предложений пока нет"
            description="Предложите, какие шаги или ожидания стоит уточнить. Тестировщик увидит правки и примет решение."
          />
        </div>
      ) : (
        <div className="panel">
          {data.data.items.map((p) => (
            <Link
              className="list-row"
              key={p.id}
              to={`/p/${project.id}/proposals/${p.id}`}
            >
              <div className="grow">
                <h3>{p.title}</h3>
                <p>{p.content.description.slice(0, 180)}</p>
              </div>
              <Badge status={p.status} />
              <ChevronRight size={16} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
