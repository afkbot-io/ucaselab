import { editorDraftKey, isProposalDraft, useEditorDraft, proposalItemIds, rememberProposalItemIds, normalizeProposalDraft } from "./editor-drafts";
import { ProposalDraftPreview, UnassignedProposalDrafts } from "./draft-preview";
import { DiscussionButton } from "./discussions";
import { useTheme } from "./theme";
import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import Markdown from "react-markdown";
import {
  ArrowLeft,
  Archive,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Lightbulb,
  LogOut,
  Mail,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { action, request } from "./api";
import { CasePicker, LabelPicker, type Choice } from "./pickers";
import { useProject, useSession } from "./context";
import type {
  Account,
  CaseContent,
  Environment,
  Member,
  Proposal,
  ProposalItem,
  Role,
  Specification,
  UseCase,
} from "./types";
import { roles, emptyContent } from "./types";
import {
  NoMatches,
  hasCatalogFilters,
  CatalogToolbar,
  CatalogPagination,
  useDebounced,
  AsyncButton,
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
import {
  DeletedFolders,
  FolderDialog,
  FolderMenu,
  FolderPicker,
  FolderScopeProvider,
  FolderTree,
  folderIndex,
  folderPath,
} from "./folder-ui";
import type { FolderTask } from "./folder-ui";
import { CaseEditor } from "./case-editor";
import { CaseDocument, NameDialog } from "./case-pages";

export function ResourcesPage({
  kind,
}: {
  kind: "specifications" | "accounts";
}) {
  return (
    <FolderScopeProvider
      kind={kind === "specifications" ? "specifications" : "use_cases"}
    >
      <ResourcesContent key={kind} kind={kind} />
    </FolderScopeProvider>
  );
}
function ResourcesContent({ kind }: { kind: "specifications" | "accounts" }) {
  const { project } = useProject(),
    [params, setParams] = useSearchParams();
  const [create, setCreate] = useState(false),
    [edit, setEdit] = useState<Specification | Account | null>(null),
    [folderTask, setFolderTask] = useState<FolderTask | null>(null),
    [deletedFolders, setDeletedFolders] = useState(false);
  const folderId = params.get("folder") || "";
  const nestedParam = params.get("nested");
  const [nested, setNested] = useState(nestedParam !== "0");
  useEffect(() => setNested(nestedParam !== "0"), [nestedParam]);
  const archived = params.get("archive") === "1",
    query = useDebounced(params.get("q") || "");
  const isSpec = kind === "specifications",
    qa = project.role !== "developer";
  const folders = useLoad(
    () =>
      isSpec
        ? folderIndex(project.id, false, "specifications")
        : Promise.resolve({ items: [] }),
    [project.id, kind],
  );
  const currentFolder = folders.data?.items.find((f) => f.id === folderId);
  function chooseFolder(id: string) {
    setParams((p) => {
      const next = new URLSearchParams(p);
      id ? next.set("folder", id) : next.delete("folder");
      next.delete("open");
      next.delete("revision");
      next.delete("page");
      return next;
    });
  }
  function reloadFolders(id?: string) {
    folders.reload();
    data.reload();
    if (id !== undefined) chooseFolder(id);
  }
  const data = useLoad(
    () =>
      action<{
        items: (Specification | Account)[];
        total: number;
        total_project?: number;
      }>(isSpec ? "list_specifications" : "list_test_accounts", project.id, {
        archived,
        search: query,
        ...(isSpec
          ? {
              tags: params.getAll("tag"),
              folder_id: folderId && folderId !== "none" ? folderId : null,
              without_folder: folderId === "none",
              include_subfolders: nested,
            }
          : {}),
        sort: params.get("sort") || "created_desc",
        limit: 50,
        offset: 50 * (Number(params.get("page")) || 0),
      }),
    [
      project.id,
      kind,
      folderId,
      nested,
      archived,
      query,
      params.get("sort"),
      params.get("page"),
      params.getAll("tag").join(),
    ],
  );
  const detail = useLoad(async () => {
    const open = params.get("open");
    if (!open) return null;
    const item = await action<Specification | Account>(
      isSpec ? "get_specification" : "get_test_account",
      project.id,
      { [isSpec ? "specification_id" : "account_id"]: open },
    );
    if (isSpec && params.get("revision")) {
      const revision = await action<{
        id: string;
        number: number;
        content: Pick<
          Specification,
          "title" | "description" | "tags" | "acceptance_criteria"
        >;
      }>("get_specification_revision", project.id, {
        specification_id: open,
        revision_id: params.get("revision"),
      });
      return {
        ...item,
        ...revision.content,
        viewed_revision_id: revision.id,
        viewed_revision_number: revision.number,
      };
    }
    return item;
  }, [project.id, kind, params.get("open"), params.get("revision")]);
  const selected = detail.data;
  const filtered = data.data?.items || [];
  return (
    <div className={isSpec ? "cases-layout specifications-layout" : ""}>
      {isSpec && (
        <aside className="folders">
          <div className="folder-head">
            <span>Спецификации</span>
            {qa && (
              <button
                className="icon-button"
                aria-label="Создать папку спецификаций"
                onClick={() => setFolderTask({ mode: "create" })}
              >
                <FolderPlus size={16} />
              </button>
            )}
          </div>
          <button
            className={"folder-link " + (!folderId ? "active" : "")}
            onClick={() => chooseFolder("")}
          >
            <BookOpen size={16} />
            <span>Все спецификации</span>
            <small>{data.data?.total_project || 0}</small>
          </button>
          <button
            className={"folder-link " + (folderId === "none" ? "active" : "")}
            onClick={() => chooseFolder("none")}
          >
            <FolderOpen size={15} />
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
              onSelect={chooseFolder}
              onTask={setFolderTask}
              onMoved={(id) => reloadFolders(id)}
              qa={qa}
            />
          )}
          {qa && (
            <div className="folder-bottom">
              <button
                className="folder-link"
                onClick={() => setDeletedFolders(true)}
              >
                <Trash2 size={15} />
                <span>Удалённые папки</span>
              </button>
            </div>
          )}
        </aside>
      )}
      <div className={isSpec ? "cases-main" : "page"}>
        <PageHead
          eyebrow={
            isSpec ? "Правила работы приложения" : "Аккаунты для проверки"
          }
          title={
            isSpec
              ? currentFolder?.name ||
                (folderId === "none"
                  ? "Спецификации без папки"
                  : archived
                    ? "Удалённые спецификации"
                    : "Спецификации")
              : "Тестовые аккаунты"
          }
          description={
            isSpec
              ? "Сохраните правила работы приложения и критерии приёмки. Их можно связать с любым юзер-кейсом."
              : "Подготовьте аккаунты для проверок: укажите логин, роль и нужное окружение. Пароли доступны только участникам с разрешением."
          }
          actions={
            qa && (
              <>
                {isSpec && currentFolder && (
                  <FolderMenu
                    folder={currentFolder}
                    folders={folders.data?.items}
                    onTask={setFolderTask}
                    onReordered={() => folders.reload()}
                  />
                )}
                {isSpec && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setFolderTask({ mode: "create", parent: currentFolder })
                    }
                  >
                    <FolderPlus size={15} />
                    {currentFolder ? "Подпапка" : "Папка"}
                  </Button>
                )}
                <Button onClick={() => setCreate(true)}>
                  <Plus size={15} />
                  {isSpec ? "Новая спецификация" : "Новый аккаунт"}
                </Button>
              </>
            )
          }
        />
        {isSpec && currentFolder && (
          <div className="folder-context">
            <nav aria-label="Путь к папке" className="folder-breadcrumbs">
              <button onClick={() => chooseFolder("")}>Все спецификации</button>
              {currentFolder.path.map((p) => (
                <span key={p.id}>
                  <ChevronRight size={12} />
                  <button
                    onClick={() => chooseFolder(p.id)}
                    aria-current={
                      p.id === currentFolder.id ? "page" : undefined
                    }
                  >
                    {p.name}
                  </button>
                </span>
              ))}
            </nav>
            <label className="folder-nested">
              <input
                type="checkbox"
                checked={nested}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setNested(checked);
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
        {isSpec && (
          <div className="mobile-folder-select">
            <FolderPicker
              library
              label="Папка спецификаций"
              rootLabel="Все спецификации"
              value={folderId}
              onChange={chooseFolder}
              known={currentFolder}
            />
            {qa && (
              <button
                className="text-link"
                onClick={() => setDeletedFolders(true)}
              >
                Удалённые папки
              </button>
            )}
          </div>
        )}
        <CatalogToolbar
          placeholder={
            isSpec
              ? "Найти по названию, тегу или тексту требования…"
              : "Найти по имени, логину или роли…"
          }
        >
          <Button
            variant="secondary"
            onClick={() =>
              setParams((p) => {
                archived ? p.delete("archive") : p.set("archive", "1");
                p.delete("page");
                return p;
              })
            }
          >
            {archived ? "Показать активные" : isSpec ? "Удалённые" : "Архив"}
          </Button>
        </CatalogToolbar>
        {isSpec && (
          <div className="catalog-filter-line">
            <LabelPicker
              scope="specifications"
              label="Теги спецификаций"
              values={params.getAll("tag")}
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
          </div>
        )}
        {data.loading ? (
          <Loading />
        ) : data.error ? (
          <ErrorState error={data.error} retry={data.reload} />
        ) : !filtered.length ? (
          <div className="panel">
            {hasCatalogFilters(params) ? (
              <NoMatches />
            ) : (
              <Empty
                title={
                  isSpec
                    ? "Зафиксируйте ожидания"
                    : "Подготовьте тестовые аккаунты"
                }
                description={
                  isSpec
                    ? "Опишите правило работы функции и результат, по которому можно понять, что оно выполнено. Затем добавьте спецификацию в нужные кейсы."
                    : "Добавьте уже подготовленный аккаунт вашего приложения. Его можно будет выбирать в сценариях, где нужен вход."
                }
                icon={isSpec ? <BookOpen size={26} /> : <Users size={26} />}
                action={
                  qa &&
                  !archived && (
                    <Button onClick={() => setCreate(true)}>
                      <Plus size={15} />
                      Добавить
                    </Button>
                  )
                }
              />
            )}
          </div>
        ) : (
          <div className="panel table-scroll">
            <table
              className={"data-table " + (isSpec ? "specification-table" : "")}
            >
              <thead>
                <tr>
                  <th>{isSpec ? "Спецификация" : "Аккаунт"}</th>
                  <th>{isSpec ? "Теги" : "Логин"}</th>
                  <th>{isSpec ? "Версия" : "Пароль"}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <button
                        className="resource-title"
                        onClick={() =>
                          setParams((p) => {
                            p.set("open", i.id);
                            p.delete("revision");
                            return p;
                          })
                        }
                      >
                        {isSpec
                          ? (i as Specification).title
                          : (i as Account).name}
                      </button>
                      {isSpec && (i as Specification).folder_id && (
                        <small className="case-folder-path">
                          {folders.data?.items.find(
                            (f) => f.id === (i as Specification).folder_id,
                          ) &&
                            folderPath(
                              folders.data.items.find(
                                (f) => f.id === (i as Specification).folder_id,
                              )!,
                            )}
                        </small>
                      )}
                      <p className="actual-excerpt">{i.description}</p>
                      {isSpec && (
                        <div className="spec-mobile-meta">
                          <span className="muted">Версия {i.version}</span>
                          {(i as Specification).tags.slice(0, 3).map((tag) => (
                            <span className="tag" key={tag} title={tag}>
                              {tag}
                            </span>
                          ))}
                          {(i as Specification).tags.length > 3 && (
                            <span className="muted">
                              Ещё {(i as Specification).tags.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {isSpec ? (
                        <div className="tags">
                          {(i as Specification).tags.map((t) => (
                            <span className="tag" key={t}>
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="mono muted">
                          {(i as Account).login}
                        </span>
                      )}
                    </td>
                    <td>
                      {isSpec ? (
                        <span className="mono muted">v{i.version}</span>
                      ) : (
                        <span className="secret-status">
                          <KeyRound size={12} />
                          {(i as Account).has_secret
                            ? "Установлен"
                            : "Не задан"}
                        </span>
                      )}
                    </td>
                    <td>
                      {qa && (
                        <AsyncButton
                          variant="ghost"
                          aria-label={
                            (archived ? "Восстановить " : "Изменить ") +
                            (isSpec
                              ? "спецификацию «" + (i as Specification).title
                              : "аккаунт «" + (i as Account).name) +
                            "»"
                          }
                          onAction={async () => {
                            if (archived) {
                              await action(
                                isSpec
                                  ? "archive_specification"
                                  : "archive_test_account",
                                project.id,
                                {
                                  object_id: i.id,
                                  expected_version: i.version,
                                  archived: false,
                                },
                              );
                              data.reload();
                              folders.reload();
                            } else setEdit(i);
                          }}
                        >
                          {archived ? "Восстановить" : <Pencil size={14} />}
                        </AsyncButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <CatalogPagination total={data.data?.total || 0} />
        {detail.error && (
          <div className="error" role="alert">
            {detail.error.message}
          </div>
        )}
        {selected && (
          <ResourceDetails
            item={selected}
            kind={kind}
            viewCurrent={() =>
              setParams((p) => {
                const next = new URLSearchParams(p);
                next.delete("revision");
                return next;
              })
            }
            close={() =>
              setParams((p) => {
                p.delete("open");
                p.delete("revision");
                return p;
              })
            }
            edit={() => {
              setParams((p) => {
                p.delete("open");
                p.delete("revision");
                return p;
              });
              setEdit(selected);
            }}
          />
        )}
        {(create || edit) && (
          <ResourceForm
            kind={kind}
            initial={edit || undefined}
            defaultFolderId={currentFolder?.id}
            close={() => {
              setCreate(false);
              setEdit(null);
            }}
            saved={() => {
              setCreate(false);
              setEdit(null);
              data.reload();
              folders.reload();
              detail.reload();
            }}
          />
        )}
      </div>
      {folderTask && (
        <FolderDialog
          task={folderTask}
          close={() => setFolderTask(null)}
          saved={(id) => reloadFolders(id)}
        />
      )}
      {deletedFolders && (
        <DeletedFolders
          close={() => setDeletedFolders(false)}
          onRestore={(folder) => setFolderTask({ mode: "restore", folder })}
        />
      )}
    </div>
  );
}

function ResourceDetails({
  item,
  kind,
  close,
  edit,
  viewCurrent,
}: {
  viewCurrent: () => void;
  item: Specification | Account;
  kind: string;
  close: () => void;
  edit: () => void;
}) {
  const { project } = useProject();
  const [secret, setSecret] = useState<string | null>(null),
    [reason, setReason] = useState(""),
    [reveal, setReveal] = useState(false),
    [history, setHistory] = useState(false),
    [historyOffset, setHistoryOffset] = useState(0);
  const isSpec = kind === "specifications";
  const revisions = useLoad(
    () =>
      isSpec && history
        ? action<{
            total: number;
            next_offset: number | null;
            items: {
              id: string;
              number: number;
              created_at: string;
              content: Specification;
            }[];
          }>("list_specification_revisions", project.id, {
            specification_id: item.id,
            limit: 20,
            offset: historyOffset,
          })
        : Promise.resolve({ items: [], total: 0, next_offset: null }),
    [project.id, item.id, history, historyOffset],
  );
  useEffect(() => {
    if (secret !== null) {
      const timer = setTimeout(() => setSecret(null), 30000);
      return () => clearTimeout(timer);
    }
  }, [secret]);
  const s = item as Specification,
    a = item as Account;
  return (
    <Dialog
      title={isSpec ? s.title : a.name}
      onClose={close}
      actions={
        <>
          {project.role !== "developer" &&
            !item.archived &&
            !s.viewed_revision_id && (
              <Button variant="secondary" onClick={edit}>
                <Pencil size={13} />
                Изменить
              </Button>
            )}
          {isSpec && (
            <DiscussionButton targetType="specification" targetId={s.id} />
          )}
        </>
      }
    >
      <div className="stack">
        <div className="inline spaced">
          <span className="mono muted">
            {s.viewed_revision_id
              ? "Закреплённая ревизия r" + s.viewed_revision_number
              : "Версия " + item.version}
            {item.archived ? " · В архиве" : ""}
          </span>
          {isSpec && s.viewed_revision_id && (
            <Button variant="secondary" onClick={viewCurrent}>
              Открыть актуальную версию
            </Button>
          )}
        </div>
        {isSpec ? (
          <>
            <div className="tags">
              {s.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
            <div className="prose">
              <Markdown>
                {s.description || "Описание ещё не добавлено"}
              </Markdown>
            </div>
            {s.acceptance_criteria && (
              <section>
                <h3 style={{ marginBottom: 12 }}>Критерии приёмки</h3>
                <div className="prose">
                  <Markdown>{s.acceptance_criteria}</Markdown>
                </div>
              </section>
            )}
            <button className="text-link" onClick={() => setHistory((v) => !v)}>
              История изменений
            </button>
            {history && (
              <div className="stack">
                {revisions.loading && <Loading />}
                {revisions.error && (
                  <ErrorState
                    error={revisions.error}
                    retry={revisions.reload}
                  />
                )}
                {revisions.data?.items.map((r) => (
                  <details key={r.id} className="revision-detail">
                    <summary>
                      Ревизия {r.number} · {date(r.created_at)}
                    </summary>
                    <div className="prose">
                      <h3>{r.content.title}</h3>
                      <Markdown>{r.content.description}</Markdown>
                      <Markdown>{r.content.acceptance_criteria}</Markdown>
                      <div className="tags">
                        {r.content.tags.map((tag) => (
                          <span className="tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </details>
                ))}
                {(historyOffset > 0 || revisions.data?.next_offset != null) && (
                  <div className="inline spaced">
                    <Button
                      variant="secondary"
                      disabled={historyOffset === 0 || revisions.loading}
                      onClick={() =>
                        setHistoryOffset((v) => Math.max(0, v - 20))
                      }
                    >
                      Новые ревизии
                    </Button>
                    <span className="muted">
                      {historyOffset + 1}–
                      {Math.min(historyOffset + 20, revisions.data?.total || 0)}{" "}
                      из {revisions.data?.total}
                    </span>
                    <Button
                      variant="secondary"
                      disabled={
                        revisions.data?.next_offset == null || revisions.loading
                      }
                      onClick={() =>
                        setHistoryOffset(revisions.data!.next_offset!)
                      }
                    >
                      Предыдущие ревизии
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <dl className="account-info">
              <dt>Логин</dt>
              <dd>{a.login || "Не указан"}</dd>
              <dt>Роль в приложении</dt>
              <dd>{a.application_role || "Не указана"}</dd>
              <dt>Описание</dt>
              <dd>{a.description || "Не добавлено"}</dd>
            </dl>
            {a.has_secret && project.can_read_secrets && (
              <>
                <div className="note">
                  Раскрытие пароля фиксируется в аудите. В окне он будет виден
                  30 секунд.
                </div>
                {secret !== null ? (
                  <div className="secret-reveal">
                    <code>{secret}</code>
                    <button
                      className="icon-button"
                      onClick={() => setSecret(null)}
                      aria-label="Скрыть пароль"
                    >
                      <EyeOff size={15} />
                    </button>
                  </div>
                ) : reveal ? (
                  <Form
                    onSubmit={async () => {
                      const r = await action<{ secret: string | null }>(
                        "reveal_test_account_secret",
                        project.id,
                        { account_id: a.id, reason },
                      );
                      setSecret(r.secret || "");
                      setReveal(false);
                    }}
                  >
                    <Field label="Зачем нужен доступ">
                      <input
                        required
                        minLength={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Проверка авторизации в staging"
                      />
                    </Field>
                    <Button type="submit" variant="secondary">
                      Показать пароль
                    </Button>
                  </Form>
                ) : (
                  <Button variant="secondary" onClick={() => setReveal(true)}>
                    <Eye size={14} />
                    Показать пароль
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function ResourceForm({
  kind,
  initial,
  close,
  saved,
  defaultFolderId,
}: {
  kind: string;
  defaultFolderId?: string;
  initial?: Specification | Account;
  close: () => void;
  saved: () => void;
}) {
  const { project } = useProject();
  const isSpec = kind === "specifications",
    s = initial as Specification | undefined,
    a = initial as Account | undefined;
  const [title, setTitle] = useState(isSpec ? s?.title || "" : a?.name || ""),
    [description, setDescription] = useState(initial?.description || ""),
    [tags, setTags] = useState<string[]>(s?.tags || []),
    [criteria, setCriteria] = useState(s?.acceptance_criteria || ""),
    [login, setLogin] = useState(a?.login || ""),
    [appRole, setAppRole] = useState(a?.application_role || ""),
    [env, setEnv] = useState(a?.environment_id || ""),
    [password, setPassword] = useState(""),
    [changePassword, setChangePassword] = useState(!initial),
    [persisted, setPersisted] = useState(initial),
    [folder, setFolder] = useState(s?.folder_id || defaultFolderId || "");
  const envs = useLoad(
    () => action<{ items: Environment[] }>("list_environments", project.id),
    [project.id],
  );
  return (
    <Dialog
      title={
        initial
          ? "Редактирование"
          : isSpec
            ? "Новая спецификация"
            : "Новый тестовый аккаунт"
      }
      onClose={close}
    >
      <Form
        onSubmit={async () => {
          const args = isSpec
            ? {
                title,
                description,
                tags,
                acceptance_criteria: criteria,
                folder_id: folder || null,
                ...(persisted ? { change_folder: true } : {}),
              }
            : {
                name: title,
                description,
                login,
                application_role: appRole,
                environment_id: env || null,
              };
          const result = await action<Specification | Account>(
            isSpec
              ? persisted
                ? "update_specification"
                : "create_specification"
              : persisted
                ? "update_test_account"
                : "create_test_account",
            project.id,
            {
              ...args,
              ...(persisted
                ? {
                    [isSpec ? "specification_id" : "account_id"]: persisted.id,
                    expected_version: persisted.version,
                  }
                : {}),
            },
          );
          setPersisted(result);
          if (!isSpec && changePassword && project.can_write_secrets) {
            const r = await action<{ version: number }>(
              "set_test_account_secret",
              project.id,
              {
                account_id: result.id,
                expected_version: result.version,
                secret: password,
              },
            );
            setPersisted({ ...result, version: r.version });
          }
          saved();
        }}
      >
        <Field label={isSpec ? "Название спецификации" : "Название аккаунта"}>
          <input
            autoFocus
            required
            maxLength={isSpec ? 240 : 160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              isSpec
                ? "Правила регистрации"
                : "Пользователь с подтверждённой почтой"
            }
          />
        </Field>
        {!isSpec && (
          <>
            <Field label="Логин">
              <input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <div className="field-row">
              <Field label="Роль в приложении">
                <input
                  value={appRole}
                  onChange={(e) => setAppRole(e.target.value)}
                  placeholder="Покупатель, администратор…"
                />
              </Field>
              <Field label="Окружение">
                <select value={env} onChange={(e) => setEnv(e.target.value)}>
                  <option value="">Любое окружение</option>
                  {envs.data?.items.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}
        <Field label="Описание">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              isSpec
                ? "Опишите требование к функционалу"
                : "Особенности аккаунта и подготовленные данные"
            }
          />
        </Field>
        {isSpec ? (
          <>
            <FolderPicker
              label="Папка спецификации"
              rootLabel="Без папки"
              value={folder}
              onChange={setFolder}
            />
            <LabelPicker
              label="Теги спецификации"
              scope="specifications"
              values={tags}
              onChange={setTags}
              hint="Помогают найти требование. У спецификаций свой набор тегов."
            />
            <Field label="Критерии приёмки">
              <textarea
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder="Как определить, что требование выполнено"
              />
            </Field>
          </>
        ) : (
          project.can_write_secrets && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={changePassword}
                  onChange={(e) => setChangePassword(e.target.checked)}
                />
                {initial ? "Заменить или удалить пароль" : "Установить пароль"}
              </label>
              {changePassword && (
                <Field
                  label="Пароль аккаунта"
                  hint="Пустое поле удалит сохранённый пароль. Значение не попадает в историю кейсов."
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              )}
            </>
          )
        )}
        {isSpec && persisted && (
          <small className="muted">
            После удаления спецификацию можно восстановить. Закреплённые в
            кейсах версии сохранятся.
          </small>
        )}
        <div className="form-footer">
          {persisted && (
            <AsyncButton
              type="button"
              variant="danger"
              onAction={async () => {
                await action(
                  isSpec ? "delete_specification" : "archive_test_account",
                  project.id,
                  {
                    [isSpec ? "specification_id" : "object_id"]: persisted.id,
                    expected_version: persisted.version,
                  },
                );
                saved();
              }}
            >
              <Archive size={13} />
              {isSpec ? "Удалить спецификацию" : "В архив"}
            </AsyncButton>
          )}
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button type="submit">Сохранить</Button>
        </div>
      </Form>
    </Dialog>
  );
}

const proposalKinds: Record<string, string> = {
  implementation_change: "Изменение кода",
  new_use_case: "Новый юзер-кейс",
  update_use_case: "Изменение юзер-кейса",
  feature_idea: "Идея для проекта",
};
export function ProposalsPage() {
  const { project } = useProject(),
    [params, setParams] = useSearchParams(),
    navigate = useNavigate();
  const search = useDebounced(params.get("q") || "");
  const data = useLoad(
    () =>
      action<{ items: Proposal[]; total: number }>(
        "list_proposals",
        project.id,
        {
          search,
          status: params.get("status") || null,
          kind: params.get("kind") || null,
          sort: params.get("sort") || "created_desc",
          limit: 50,
          offset: 50 * (Number(params.get("page")) || 0),
        },
      ),
    [
      project.id,
      search,
      params.get("status"),
      params.get("kind"),
      params.get("sort"),
      params.get("page"),
    ],
  );
  const filtered = data.data?.items || [];
  return (
    <div className="page">
      <PageHead
        eyebrow="Изменения и развитие"
        title="Предложения"
        description="Предлагайте новые сценарии и уточняйте существующие, когда меняются функции приложения."
        actions={
          <Button onClick={() => setParams({ new: "1" })}>
            <Plus size={15} />
            Новое предложение
          </Button>
        }
      />
      <CatalogToolbar
        placeholder="Найти предложение по названию или описанию…"
        statuses={[
          ["open", "На рассмотрении"],
          ["accepted", "Принятые"],
          ["rejected", "Отклонённые"],
          ["withdrawn", "Отозванные"],
        ]}
        kinds={Object.entries(proposalKinds)}
      />
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !filtered.length ? (
        <div className="panel">
          {hasCatalogFilters(params) ? (
            <NoMatches />
          ) : (
            <Empty
              title="Помогите библиотеке оставаться актуальной"
              description="Заметили, что сценарию не хватает шагов, или добавили новую функцию? Расскажите, что нужно проверить. Тестировщик рассмотрит предложение и дополнит библиотеку."
              icon={<Lightbulb size={26} />}
              action={
                <Button onClick={() => setParams({ new: "1" })}>
                  Создать предложение
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <div className="panel">
          {filtered.map((p) => (
            <Link key={p.id} className="list-row proposal-list-row" to={p.id}>
              <div className="proposal-icon">
                <Lightbulb size={19} />
              </div>
              <div className="grow">
                <h3>{p.title}</h3>
                <p>
                  {proposalKinds[p.kind]} · {date(p.created_at)}
                </p>
              </div>
              <Badge status={p.status} />
              <ChevronRight size={16} />
            </Link>
          ))}
        </div>
      )}
      <CatalogPagination total={data.data?.total || 0} />
      {params.has("new") && (
        <ProposalForm
          key={project.id + ":new:" + (params.get("case") || "create")}
          caseId={params.get("case")}
          close={() => setParams({})}
          saved={(p) => {
            setParams({});
            navigate(p.id);
          }}
        />
      )}
    </div>
  );
}

function ProposalForm({
  initial,
  caseId,
  close,
  saved,
}: {
  initial?: Proposal;
  caseId?: string | null;
  close: () => void;
  saved: (p: Proposal) => void;
}) {
  const { project } = useProject();
  const { user } = useSession();
  const initialTarget =
    initial?.target_use_case_id ||
    caseId ||
    initial?.content.items.find((i) => i.action === "update_use_case")
      ?.use_case_id;
  const context = `proposal:${initial?.id || "new:" + (caseId || "create")}`;
  const [initialItemIds] = useState(() => initial ? proposalItemIds(user.id, project.id, initial) : []);
  const draft = useEditorDraft(
    editorDraftKey(user.id, project.id, context),
    JSON.stringify(initial || null),
    {
      title: initial?.title || "",
      kind: initial?.kind || (caseId ? "update_use_case" : "new_use_case"),
      description: initial?.content.description || "",
      target: (initialTarget ? [{ id: initialTarget, label: "Загружаем юзер-кейс…" }] : []) as Choice[],
      repository: initial?.content.repository || "",
      sha: initial?.content.commit_sha || "",
      pr: initial?.content.pull_request_url || "",
      fingerprint: initial?.content.diff_fingerprint || "",
      impact: initial?.content.impact || "unknown",
      items: initial?.content.items || [] as ProposalItem[],
      itemIds: initialItemIds,
      newItemId: crypto.randomUUID(),
    },
    isProposalDraft,
    normalizeProposalDraft,
  );
  const { title, kind, description, target, repository, sha, pr, fingerprint, impact, items, itemIds } = draft.value;
  function field<K extends keyof typeof draft.value>(name: K, value: (typeof draft.value)[K]) {
    draft.update((previous) => ({ ...previous, [name]: value }));
  }
  const setTitle = (v: string) => field("title", v);
  const setKind = (v: string) => field("kind", v);
  const setDescription = (v: string) => field("description", v);
  const setTarget = (v: Choice[]) => field("target", v);
  const setRepository = (v: string) => field("repository", v);
  const setSha = (v: string) => field("sha", v);
  const setPr = (v: string) => field("pr", v);
  const setFingerprint = (v: string) => field("fingerprint", v);
  const setImpact = (v: string) => field("impact", v);
  const [initialTargetLabel, setInitialTargetLabel] = useState<Choice | null>(null);
  const displayTarget = target.map((choice) => choice.id === initialTargetLabel?.id ? initialTargetLabel : choice);
  const [editor, setEditor] = useState<{
    index: number;
    scope: string;
    content: CaseContent;
    item: ProposalItem;
  } | null>(null);
  const update =
    kind === "update_use_case" ||
    (kind === "implementation_change" &&
      !!(target.length || initial?.target_use_case_id));
  useEffect(() => {
    let active = true;
    if (initialTarget)
      action<UseCase>("get_use_case", project.id, {
        use_case_id: initialTarget,
      })
        .then((c) => {
          if (active) setInitialTargetLabel({ id: c.id, label: c.title, detail: c.key });
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [project.id, initialTarget]);
  async function prepare() {
    // The parent may still be empty: persist its child identity before opening.
    draft.write(draft.value);
    if (!update) {
      setEditor({
        index: -1,
        scope: `${draft.value.newItemId}:${kind}:create`,
        content: { ...emptyContent(), title, steps: [{ key: draft.value.newItemId, action: "", expected: "" }] },
        item: { action: "create_use_case" },
      });
      return;
    }
    if (!target[0]) throw new Error("Сначала выберите юзер-кейс для изменения");
    const c = await action<UseCase>("get_use_case", project.id, {
      use_case_id: target[0].id,
    });
    setEditor({
      index: -1,
      scope: `${draft.value.newItemId}:${kind}:${c.id}`,
      content: c.content,
      item: {
        action: "update_use_case",
        use_case_id: c.id,
        base_revision_id: c.revision_id,
        folder_id: c.folder_id,
      },
    });
  }
  return (
    <>
      <Dialog
        title={initial ? "Изменить предложение" : "Новое предложение"}
        onClose={close}
        wide
      >
        <Form
          onSubmit={async () => {
            if (
              update &&
              !target.length &&
              !items.some((i) => i.action === "update_use_case")
            )
              throw new Error("Найдите юзер-кейс, который хотите изменить");
            if (
              (repository ||
                sha ||
                fingerprint ||
                kind === "implementation_change") &&
              (!repository || !(sha || fingerprint))
            )
              throw new Error(
                "Для изменения кода укажите репозиторий и SHA коммита или отпечаток diff",
              );
            if (draft.conflict) throw new Error("Сначала выберите версию текста");
            const submitted = draft.value;
            const p = await action<Proposal>(
              initial ? "update_proposal" : "submit_proposal",
              project.id,
              {
                ...(initial
                  ? {
                      proposal_id: initial.id,
                      expected_version: initial.version,
                    }
                  : {
                      kind,
                      target_use_case_id: update ? target[0]?.id || null : null,
                    }),
                title,
                content: {
                  description,
                  items,
                  repository,
                  commit_sha: sha,
                  pull_request_url: pr,
                  diff_fingerprint: fingerprint,
                  impact,
                },
              },
            );
            rememberProposalItemIds(user.id, project.id, p, submitted.itemIds, context);
            draft.clearSubmitted(submitted);
            saved(p);
          }}
        >
          <UnassignedProposalDrafts context={context} activeIds={itemIds} pendingId={draft.value.newItemId} />
          {draft.conflict ? <section className="draft-recovery">
            <p className="note">На сервере появилась новая версия предложения. Локальный текст сохранён отдельно.</p>
            <details><summary>Локальный текст</summary><ProposalDraftPreview value={draft.conflict.value} /></details>
            <details><summary>Текущая версия</summary><ProposalDraftPreview value={draft.value} /></details>
            <Button type="button" onClick={() => draft.recover(true)}>Восстановить локальный текст</Button>
            <Button type="button" variant="secondary" onClick={() => draft.recover(false)}>Удалить локальный черновик</Button>
          </section> : <>
          {!initial && (
            <div
              className="proposal-intents"
              role="group"
              aria-label="Что предложить"
            >
              <button
                type="button"
                aria-pressed={!update}
                disabled={!!items.length && update}
                className={!update ? "selected" : ""}
                onClick={() => {
                  draft.write({ ...draft.value, kind: "new_use_case", target: [] });
                }}
              >
                <span className="intent-icon">
                  <Plus size={20} />
                </span>
                <span>
                  <strong>Новый юзер-кейс</strong>
                  <small>Какой функционал ещё нужно описать и проверить</small>
                </span>
                {!update && <Check size={17} />}
              </button>
              <button
                type="button"
                aria-pressed={update}
                disabled={!!items.length && !update}
                className={update ? "selected" : ""}
                onClick={() => setKind("update_use_case")}
              >
                <span className="intent-icon">
                  <Pencil size={19} />
                </span>
                <span>
                  <strong>Изменение существующего</strong>
                  <small>Что нужно уточнить в готовом сценарии</small>
                </span>
                {update && <Check size={17} />}
              </button>
            </div>
          )}
          {update &&
            (items.some((i) => i.action === "update_use_case") ? (
              <div className="proposal-target-summary">
                <FileText size={16} />
                <span>
                  Кейсы для изменения указаны в подготовленных правках ниже.
                </span>
              </div>
            ) : (
              <CasePicker values={displayTarget} onChange={setTarget} />
            ))}
          <Field label="Название предложения">
            <input
              required
              value={title}
              maxLength={240}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                update
                  ? "Например, добавить вход по одноразовому коду…"
                  : "Например, описать восстановление пароля…"
              }
            />
          </Field>
          <Field
            label={
              update
                ? "Что нужно изменить и почему?"
                : "Что нужно описать и проверить?"
            }
          >
            <textarea
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder={
                update
                  ? "Как сейчас работает функция, что поменялось и какой результат должен увидеть пользователь…"
                  : "Какую задачу решает пользователь, как выглядит успешный результат и какие ограничения нужно учесть…"
              }
            />
          </Field>
          <section className="proposal-preparation">
            <div className="inline spaced">
              <div>
                <h3>
                  Конкретные правки{" "}
                  <span className="optional-label">необязательно</span>
                </h3>
                <p>
                  Можно отправить описание или сразу предложить шаги и варианты
                  данных. Кейс появится в библиотеке только после принятия.
                </p>
              </div>
            </div>
            {items.map((item, i) => (
              <div className="proposal-prepared-row" key={itemIds[i]}>
                <span className="proposal-icon">
                  {item.action === "create_use_case" ? (
                    <Plus size={17} />
                  ) : (
                    <Pencil size={17} />
                  )}
                </span>
                <div className="grow">
                  <strong>{item.content?.title || item.note}</strong>
                  <small>
                    {item.action === "create_use_case"
                      ? "Предложенный новый сценарий"
                      : item.action === "update_use_case"
                        ? "Изменения сценария"
                        : "Примечание"}
                  </small>
                </div>
                {item.content && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Изменить предложенный сценарий"
                    onClick={() =>
                      setEditor({ index: i, scope: itemIds[i], content: item.content!, item })
                    }
                  >
                    <Pencil size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Убрать предложенный сценарий"
                  onClick={() => draft.write({ ...draft.value, items: items.filter((_, n) => n !== i), itemIds: itemIds.filter((_, n) => n !== i) })}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            {!items.length && (
              <AsyncButton
                type="button"
                variant="secondary"
                disabled={update && !target.length}
                onAction={prepare}
              >
                <Pencil size={14} />
                {update
                  ? "Подготовить правки сценария"
                  : "Предложить шаги и данные"}
              </AsyncButton>
            )}
          </section>
          <details
            className="proposal-code-details"
            open={kind === "implementation_change" || undefined}
          >
            <summary>
              <Code2 size={16} />
              Предложение связано с изменением кода
              <span className="optional-label">
                репозиторий, коммит, pull request
              </span>
            </summary>
            <p className="field-hint">
              Укажите источник изменения, чтобы тестировщик мог сравнить новое
              поведение с описанием сценария.
            </p>
            <div className="field-row">
              <Field label="Репозиторий">
                <input
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder="org/repository…"
                />
              </Field>
              <Field label="Что изменилось для пользователя?">
                <select
                  value={impact}
                  onChange={(e) => setImpact(e.target.value)}
                >
                  <option value="unknown">Нужно проверить</option>
                  <option value="behavior_changed">
                    Изменились действия или результат
                  </option>
                  <option value="no_behavior_change">
                    Поведение осталось прежним
                  </option>
                </select>
              </Field>
            </div>
            <div className="field-row">
              <Field label="SHA коммита">
                <input
                  value={sha}
                  onChange={(e) => setSha(e.target.value)}
                  minLength={40}
                  maxLength={64}
                  placeholder="Полный SHA: 40 или 64 символа…"
                />
              </Field>
              <Field label="Ссылка на pull request">
                <input
                  type="url"
                  value={pr}
                  onChange={(e) => setPr(e.target.value)}
                  placeholder="https://…"
                />
              </Field>
            </div>
            <Field
              label="Отпечаток diff"
              hint="Для ещё не закоммиченных изменений. После коммита используйте его полный SHA."
            >
              <input
                value={fingerprint}
                onChange={(e) => setFingerprint(e.target.value)}
                placeholder="Хеш подготовленных изменений…"
              />
            </Field>
          </details>
          <div className="form-footer">
            <Button type="button" variant="secondary" onClick={close}>
              Отмена
            </Button>
            <Button type="submit">
              {initial ? "Сохранить предложение" : "Отправить на рассмотрение"}
            </Button>
          </div>
          </>}
        </Form>
      </Dialog>
      {editor && (
        <CaseEditor
          key={context + ":" + editor.scope}
          draftId={context + ":item:" + editor.scope}
          revision={editor.item.base_revision_id || undefined}
          initial={editor.content}
          folderId={editor.item.folder_id}
          title={
            update
              ? "Предложить изменения сценария"
              : "Предложить новый сценарий"
          }
          onClose={() => setEditor(null)}
          onSave={async (content, folder_id) => {
            const item = { ...editor.item, content, folder_id };
            draft.write({
              ...draft.value,
              items: editor.index < 0 ? [...items, item] : items.map((a, i) => i === editor.index ? item : a),
              itemIds: editor.index < 0 ? [...itemIds, editor.scope] : itemIds,
              newItemId: editor.index < 0 ? crypto.randomUUID() : draft.value.newItemId,
            });
            setEditor(null);
          }}
        />
      )}
    </>
  );
}
export function ProposalPage() {
  const { project } = useProject(),
    { user } = useSession(),
    { proposalId } = useParams(),
    navigate = useNavigate();
  const data = useLoad(
    () =>
      action<Proposal>("get_proposal", project.id, { proposal_id: proposalId }),
    [project.id, proposalId],
  );
  const [edit, setEdit] = useState(false),
    [removing, setRemoving] = useState(false),
    [decision, setDecision] = useState<"accept" | "reject" | null>(null),
    [preview, setPreview] = useState<{
      changes: { item: number; changes: unknown[] }[];
      conflicts: unknown[];
    } | null>(null);
  if (data.loading && !data.data) return <Loading />;
  if (data.error || !data.data)
    return <ErrorState error={data.error} retry={data.reload} />;
  const p = data.data,
    qa = project.role !== "developer";
  return (
    <div className="page">
      <Link className="back" to="../proposals">
        <ArrowLeft size={14} />К предложениям
      </Link>
      <PageHead
        eyebrow={
          <>
            <Badge status={p.status} />
            <span>
              {proposalKinds[p.kind]} · {date(p.created_at)}
            </span>
          </>
        }
        title={p.title}
        actions={
          <>
            {p.status === "open" && (
              <>
                {p.author_id === user.id && (
                  <>
                    <Button variant="secondary" onClick={() => setEdit(true)}>
                      Изменить
                    </Button>
                    <AsyncButton
                      variant="ghost"
                      onAction={async () => {
                        await action("withdraw_proposal", project.id, {
                          proposal_id: p.id,
                          expected_version: p.version,
                        });
                        data.reload();
                      }}
                    >
                      Отозвать
                    </AsyncButton>
                  </>
                )}
                {qa && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => setDecision("reject")}
                    >
                      Отклонить
                    </Button>
                    <Button onClick={() => setDecision("accept")}>
                      <Check size={14} />
                      Принять
                    </Button>
                  </>
                )}
              </>
            )}
            {p.status === "rejected" && (qa || p.author_id === user.id) && (
              <Button variant="danger" onClick={() => setRemoving(true)}>
                <Trash2 size={15} />
                Удалить
              </Button>
            )}
            <DiscussionButton targetType="proposal" targetId={p.id} />
          </>
        }
      />
      {removing && (
        <DeleteProposalDialog
          proposal={p}
          close={() => setRemoving(false)}
          deleted={() =>
            navigate(`/p/${project.id}/proposals`, { replace: true })
          }
        />
      )}
      <div className="proposal-detail">
        <section className="section">
          <h2 style={{ marginBottom: 16 }}>Описание</h2>
          <div className="prose">
            <Markdown>{p.content.description}</Markdown>
          </div>
        </section>
        {p.kind === "implementation_change" && (
          <div className="panel code-reference">
            <Code2 size={22} />
            <div className="grow">
              <h3>{p.content.repository}</h3>
              <p className="mono">
                {p.content.commit_sha ||
                  "Рабочий diff: " + p.content.diff_fingerprint}
              </p>
              <small>
                {p.content.impact === "behavior_changed"
                  ? "Поведение изменилось"
                  : p.content.impact === "no_behavior_change"
                    ? "Поведение не изменилось"
                    : "Влияние требует уточнения"}
              </small>
            </div>
            {p.content.pull_request_url && (
              <a
                href={p.content.pull_request_url}
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                Pull request ↗
              </a>
            )}
          </div>
        )}
        {p.content.items.length > 0 && (
          <section className="section">
            <div className="section-title">
              <h2>Изменения юзер-кейсов</h2>
              {qa && (
                <AsyncButton
                  variant="secondary"
                  onAction={async () =>
                    setPreview(
                      await action("preview_proposal", project.id, {
                        proposal_id: p.id,
                      }),
                    )
                  }
                >
                  Проверить конфликты
                </AsyncButton>
              )}
            </div>
            {preview && (
              <div
                className={preview.conflicts.length ? "error" : "note"}
                style={{ marginBottom: 20 }}
              >
                {preview.conflicts.length
                  ? "Базовые версии изменились. Нужно обновить предложение."
                  : "Конфликтов нет. Принятие создаст черновики."}
              </div>
            )}
            {p.content.items.map((item, i) => (
              <details className="proposal-content-item" key={i}>
                <summary>
                  {item.action === "create_use_case"
                    ? "Новый кейс"
                    : item.action === "update_use_case"
                      ? "Изменение кейса"
                      : "Примечание"}{" "}
                  · {item.content?.title || item.note}
                </summary>
                {item.content && <CaseDocument content={item.content} />}
              </details>
            ))}
          </section>
        )}
        {p.decision && (
          <div className="decision-box">
            <Badge status={p.status} />
            <p>
              {p.decision.reason ||
                "Решение принято без дополнительного комментария"}
            </p>
            {p.decision.applied_items?.map((i, index) => (
              <Link
                className="text-link"
                key={index}
                to={`/p/${project.id}/cases/${i.use_case_id}`}
              >
                Открыть подготовленный черновик #{index + 1} ↗
              </Link>
            ))}
          </div>
        )}
      </div>
      {edit && (
        <ProposalForm
          key={project.id + ":" + p.id + ":" + p.version}
          initial={p}
          close={() => setEdit(false)}
          saved={() => {
            setEdit(false);
            data.reload();
          }}
        />
      )}
      {decision && (
        <NameDialog
          title={
            decision === "accept"
              ? "Принять предложение"
              : "Отклонить предложение"
          }
          label={
            decision === "accept"
              ? "Комментарий к решению"
              : "Причина отклонения"
          }
          initial={
            decision === "accept"
              ? p.content.items.some((i) => i.content)
                ? "Правки согласованы"
                : "Идея принята в работу"
              : ""
          }
          close={() => setDecision(null)}
          submit={async (reason) => {
            await action(
              decision === "accept" ? "accept_proposal" : "reject_proposal",
              project.id,
              { proposal_id: p.id, expected_version: p.version, reason },
            );
            setDecision(null);
            data.reload();
          }}
        />
      )}
    </div>
  );
}

function DeleteProposalDialog({
  proposal,
  close,
  deleted,
}: {
  proposal: Proposal;
  close: () => void;
  deleted: () => void;
}) {
  const { project } = useProject();
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      title="Удалить отклонённое предложение"
      onClose={() => {
        if (!pending) close();
      }}
      focusField={false}
    >
      <Form
        pendingLabel="Удаляем…"
        onSubmit={async () => {
          setPending(true);
          try {
            await action("delete_proposal", project.id, {
              proposal_id: proposal.id,
              expected_version: proposal.version,
            });
            deleted();
          } finally {
            setPending(false);
          }
        }}
      >
        <p>
          Удалить «{proposal.title}»? Предложение исчезнет из списка. Решение и
          история сохранятся.
        </p>
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button type="submit" variant="danger">
            <Trash2 size={15} />
            Удалить
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

export function SettingsPage() {
  const { project, reload } = useProject();
  const [params, setParams] = useSearchParams();
  const manager = project.role === "manager" || project.role === "owner";
  const allowed = ["general", "team", "environments", "guide", "notifications", ...(manager ? ["audit"] : [])];
  const requested = params.get("tab") || "general";
  const tab = allowed.includes(requested) ? requested : "general";
  const setTab = (value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set("tab", allowed.includes(value) ? value : "general");
    return next;
  });
  return (
    <div className="page">
      <PageHead
        eyebrow="Управление пространством"
        title="Настройки проекта"
        description="Пригласите команду, подготовьте окружения и задайте правила работы с проектом."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "general", label: "Общее" },
          { key: "team", label: "Команда" },
          { key: "environments", label: "Окружения" },
          { key: "guide", label: "Инструкции ИИ" },
          { key: "notifications", label: "Уведомления" },
          ...(manager ? [{ key: "audit", label: "Аудит" }] : []),
        ]}
      />
      {tab === "general" ? (
        <GeneralSettings key={project.version} reload={reload} />
      ) : tab === "team" ? (
        <TeamSettings />
      ) : tab === "environments" ? (
        <EnvironmentsSettings />
      ) : tab === "guide" ? (
        <GuideSettings />
      ) : tab === "notifications" ? (
        <NotificationSettings />
      ) : (
        <AuditSettings />
      )}
    </div>
  );
}
function GeneralSettings({ reload }: { reload: () => void }) {
  const { project } = useProject(),
    navigate = useNavigate(),
    session = useSession();
  const [name, setName] = useState(project.name),
    [description, setDescription] = useState(project.description),
    [transfer, setTransfer] = useState(false),
    [nextOwner, setNextOwner] = useState("");
  const manager = project.role === "owner" || project.role === "manager";
  const members = useLoad(
    () => action<{ items: Member[] }>("list_project_members", project.id),
    [project.id],
  );
  return (
    <div className="settings-content">
      <Form
        onSubmit={async () => {
          await action("update_project", project.id, {
            expected_version: project.version,
            name,
            description,
          });
          reload();
        }}
      >
        <Field label="Название проекта">
          <input
            required
            disabled={!manager}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Ключ">
          <input disabled value={project.key} />
        </Field>
        <Field label="Описание">
          <textarea
            disabled={!manager}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {manager && <Button type="submit">Сохранить изменения</Button>}
      </Form>
      <div className="divider" />
      <dl className="account-info">
        <dt>Ваша роль</dt>
        <dd>{roles[project.role]}</dd>
        <dt>Руководитель</dt>
        <dd>
          {members.data?.items.find((m) => m.role === "owner")?.name || "—"}
        </dd>
      </dl>
      {project.role !== "developer" && (
        <AsyncButton
          variant="secondary"
          onAction={async () => {
            const data = await action("export_project", project.id);
            const blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
              }),
              url = URL.createObjectURL(blob),
              a = document.createElement("a");
            a.href = url;
            a.download = project.key + "-export.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={14} />
          Экспортировать проект без секретов
        </AsyncButton>
      )}
      {project.role === "owner" && (
        <div className="owner-actions">
          <h3>Владение проектом</h3>
          <p>
            Руководитель управляет менеджерами и может передать владение другому
            участнику.
          </p>
          <div className="inline">
            <Button variant="secondary" onClick={() => setTransfer(true)}>
              Передать владение
            </Button>
            <AsyncButton
              variant="danger"
              onAction={async () => {
                await action("archive_project", project.id, {
                  expected_version: project.version,
                });
                session.reloadProjects();
                navigate("/");
              }}
            >
              <Archive size={14} />
              Архивировать проект
            </AsyncButton>
          </div>
        </div>
      )}
      {transfer && (
        <Dialog
          title="Передать владение проектом"
          onClose={() => setTransfer(false)}
        >
          <Form
            onSubmit={async () => {
              await action("transfer_project_management", project.id, {
                new_owner_user_id: nextOwner,
                former_owner_role: "manager",
              });
              setTransfer(false);
              reload();
            }}
          >
            <div className="note" style={{ marginBottom: 20 }}>
              Вы станете менеджером. Новый руководитель получит управление
              владельцем и менеджерами, секретами и архивированием проекта.
            </div>
            <Field label="Новый руководитель">
              <select
                required
                value={nextOwner}
                onChange={(e) => setNextOwner(e.target.value)}
              >
                <option value="">Выберите участника</option>
                {members.data?.items
                  .filter((m) => m.role !== "owner")
                  .map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name} · {roles[m.role]}
                    </option>
                  ))}
              </select>
            </Field>
            <Button type="submit" disabled={!nextOwner}>
              Передать владение
            </Button>
          </Form>
        </Dialog>
      )}
    </div>
  );
}

function TeamSettings() {
  const { project } = useProject();
  const [invite, setInvite] = useState(false),
    [edit, setEdit] = useState<Member | null>(null),
    [link, setLink] = useState("");
  const manager = ["manager", "owner"].includes(project.role);
  const data = useLoad(
    () => action<{ items: Member[] }>("list_project_members", project.id),
    [project.id],
  );
  const invitations = useLoad(
    () =>
      manager
        ? action<{
            items: {
              id: string;
              email: string;
              role: Role;
              expires_at: string;
              revoked: boolean;
              accepted: boolean;
            }[];
          }>("list_project_invitations", project.id)
        : Promise.resolve({ items: [] }),
    [project.id, manager],
  );
  return (
    <div className="stack">
      <div className="inline spaced">
        <div>
          <h2>Участники проекта</h2>
          <p className="settings-hint">
            Разработчик → Тестировщик → Менеджер → Руководитель
          </p>
        </div>
        {manager && (
          <Button onClick={() => setInvite(true)}>
            <Plus size={14} />
            Пригласить
          </Button>
        )}
      </div>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : (
        <div className="panel table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Участник</th>
                <th>Роль</th>
                <th>Доступ к секретам</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.data?.items.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="inline">
                      <span className="avatar">{m.name.slice(0, 1)}</span>
                      <div>
                        <strong>{m.name}</strong>
                        <p>
                          <small>{m.email}</small>
                        </p>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="tag">{roles[m.role]}</span>
                  </td>
                  <td>
                    <small>
                      {m.can_read_secrets ? "Чтение" : "Без чтения"} ·{" "}
                      {m.can_write_secrets ? "Изменение" : "Без изменения"}
                    </small>
                  </td>
                  <td>
                    {manager &&
                      m.role !== "owner" &&
                      (project.role === "owner" || m.role !== "manager") && (
                        <Button variant="ghost" onClick={() => setEdit(m)}>
                          <Pencil size={14} />
                        </Button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manager &&
        invitations.data?.items.some((i) => !i.revoked && !i.accepted) && (
          <section className="section">
            <div className="section-title">
              <h2>Ожидают принятия</h2>
            </div>
            <div className="panel">
              {invitations.data.items
                .filter((i) => !i.revoked && !i.accepted)
                .map((i) => (
                  <div className="list-row" key={i.id}>
                    <Mail size={17} color="#9aaac7" />
                    <div className="grow">
                      <h3>{i.email}</h3>
                      <p>
                        {roles[i.role]} · до {date(i.expires_at)}
                      </p>
                    </div>
                    {(project.role === "owner" || i.role !== "manager") && (
                      <AsyncButton
                        variant="ghost"
                        onAction={async () => {
                          await action(
                            "revoke_project_invitation",
                            project.id,
                            { invitation_id: i.id },
                          );
                          invitations.reload();
                        }}
                      >
                        Отозвать
                      </AsyncButton>
                    )}
                  </div>
                ))}
            </div>
          </section>
        )}
      {invite && (
        <InviteForm
          close={() => setInvite(false)}
          saved={(url) => {
            setInvite(false);
            setLink(url);
            invitations.reload();
          }}
        />
      )}
      {link && (
        <Dialog title="Приглашение создано" onClose={() => setLink("")}>
          <div className="stack">
            <p className="dialog-description">
              Передайте ссылку участнику. Для вступления нужно войти с указанным
              email. Приглашение действует семь дней.
            </p>
            <input readOnly className="input mono" value={link} />
            <AsyncButton onAction={() => navigator.clipboard.writeText(link)}>
              <Copy size={14} />
              Скопировать ссылку
            </AsyncButton>
          </div>
        </Dialog>
      )}
      {edit && (
        <MemberForm
          member={edit}
          close={() => setEdit(null)}
          saved={() => {
            setEdit(null);
            data.reload();
          }}
        />
      )}
    </div>
  );
}
function InviteForm({
  close,
  saved,
}: {
  close: () => void;
  saved: (url: string) => void;
}) {
  const { project } = useProject();
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("tester");
  return (
    <Dialog title="Пригласить в проект" onClose={close}>
      <Form
        onSubmit={async () => {
          const r = await action<{ invitation_url: string }>(
            "invite_project_member",
            project.id,
            { email, role, send_email: true },
          );
          saved(r.invitation_url);
        }}
      >
        <Field label="Электронная почта">
          <input
            autoFocus
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Роль">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {(
              [
                "developer",
                "tester",
                ...(project.role === "owner" ? ["manager"] : []),
              ] as Role[]
            ).map((r) => (
              <option key={r} value={r}>
                {roles[r]}
              </option>
            ))}
          </select>
        </Field>
        <div className="role-explanation">
          {role === "developer"
            ? "Читает опубликованные сценарии, обсуждает и отправляет предложения."
            : role === "tester"
              ? "Ведёт сценарии, публикации, планы, проверки и отчёты."
              : "Управляет QA, настройками и участниками с ролями разработчика и тестировщика."}
        </div>
        <div className="form-footer">
          <Button type="submit">Создать приглашение</Button>
        </div>
      </Form>
    </Dialog>
  );
}
function MemberForm({
  member,
  close,
  saved,
}: {
  member: Member;
  close: () => void;
  saved: () => void;
}) {
  const { project } = useProject();
  const [role, setRole] = useState(member.role),
    [read, setRead] = useState(member.can_read_secrets),
    [write, setWrite] = useState(member.can_write_secrets);
  return (
    <Dialog title={member.name} onClose={close}>
      <Form
        onSubmit={async () => {
          await action("update_project_member", project.id, {
            member_id: member.id,
            role,
            can_read_secrets: read,
            can_write_secrets: write,
          });
          saved();
        }}
      >
        <Field label="Роль в проекте">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {(
              [
                "developer",
                "tester",
                ...(project.role === "owner" ? ["manager"] : []),
              ] as Role[]
            ).map((r) => (
              <option key={r} value={r}>
                {roles[r]}
              </option>
            ))}
          </select>
        </Field>
        <label className="check-label">
          <input
            type="checkbox"
            checked={read}
            onChange={(e) => setRead(e.target.checked)}
          />
          Может раскрывать пароли тестовых аккаунтов
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={write}
            onChange={(e) => setWrite(e.target.checked)}
          />
          Может изменять пароли тестовых аккаунтов
        </label>
        <div className="form-footer">
          <AsyncButton
            variant="danger"
            type="button"
            onAction={async () => {
              await action("remove_project_member", project.id, {
                member_id: member.id,
              });
              saved();
            }}
          >
            Удалить из проекта
          </AsyncButton>
          <Button type="submit">Сохранить права</Button>
        </div>
      </Form>
    </Dialog>
  );
}

function EnvironmentsSettings() {
  const { project } = useProject();
  const [create, setCreate] = useState(false),
    [edit, setEdit] = useState<Environment | null>(null),
    [archive, setArchive] = useState(false);
  const data = useLoad(
    () =>
      action<{ items: Environment[] }>("list_environments", project.id, {
        archived: archive,
      }),
    [project.id, archive],
  );
  const manager = ["manager", "owner"].includes(project.role);
  return (
    <div className="stack">
      <div className="inline spaced">
        <div>
          <h2>Окружения</h2>
          <p className="settings-hint">
            Адрес и конфигурация фиксируются в каждом новом прогоне.
          </p>
        </div>
        {manager && (
          <Button onClick={() => setCreate(true)}>
            <Plus size={14} />
            Добавить окружение
          </Button>
        )}
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={archive}
          onChange={(e) => setArchive(e.target.checked)}
        />
        Показывать архив
      </label>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !data.data?.items.length ? (
        <div className="panel">
          <Empty
            title="Добавьте тестовое окружение"
            description="Например, Staging, Production или локальная сборка. Это поможет повторить проверку в нужных условиях."
          />
        </div>
      ) : (
        <div className="panel">
          {data.data.items.map((e) => (
            <div className="list-row" key={e.id}>
              <span className="environment-dot" />
              <div className="grow">
                <h3>{e.name}</h3>
                <p>
                  {e.base_url || "Адрес не задан"} · {e.description}
                </p>
              </div>
              {manager &&
                (archive ? (
                  <AsyncButton
                    variant="secondary"
                    onAction={async () => {
                      await action("archive_environment", project.id, {
                        object_id: e.id,
                        expected_version: e.version,
                        archived: false,
                      });
                      data.reload();
                    }}
                  >
                    Восстановить
                  </AsyncButton>
                ) : (
                  <Button variant="ghost" onClick={() => setEdit(e)}>
                    <Pencil size={14} />
                  </Button>
                ))}
            </div>
          ))}
        </div>
      )}
      {(create || edit) && (
        <EnvironmentForm
          initial={edit || undefined}
          close={() => {
            setCreate(false);
            setEdit(null);
          }}
          saved={() => {
            setCreate(false);
            setEdit(null);
            data.reload();
          }}
        />
      )}
    </div>
  );
}
function EnvironmentForm({
  initial,
  close,
  saved,
}: {
  initial?: Environment;
  close: () => void;
  saved: () => void;
}) {
  const { project } = useProject();
  const [name, setName] = useState(initial?.name || ""),
    [url, setUrl] = useState(initial?.base_url || ""),
    [description, setDescription] = useState(initial?.description || ""),
    [configuration, setConfig] = useState(
      Object.entries(initial?.configuration || {}).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    );
  return (
    <Dialog
      title={initial ? "Изменить окружение" : "Новое окружение"}
      onClose={close}
    >
      <Form
        onSubmit={async () => {
          await action(
            initial ? "update_environment" : "create_environment",
            project.id,
            {
              ...(initial
                ? {
                    environment_id: initial.id,
                    expected_version: initial.version,
                  }
                : {}),
              name,
              base_url: url,
              description,
              configuration: Object.fromEntries(
                configuration.filter((c) => c.key).map((c) => [c.key, c.value]),
              ),
            },
          );
          saved();
        }}
      >
        <Field label="Название">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Staging"
          />
        </Field>
        <Field label="Адрес приложения">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://staging.example.com"
          />
        </Field>
        <Field label="Описание">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <h3 style={{ marginBottom: 14 }}>Конфигурация без секретов</h3>
        {configuration.map((c, i) => (
          <div className="inline" key={i} style={{ marginBottom: 8 }}>
            <input
              className="input"
              style={{ width: "40%" }}
              aria-label="Параметр"
              placeholder="browser"
              value={c.key}
              onChange={(e) =>
                setConfig((s) =>
                  s.map((v, n) =>
                    n === i ? { ...v, key: e.target.value } : v,
                  ),
                )
              }
            />
            <input
              className="input"
              style={{ width: "40%" }}
              aria-label="Значение"
              placeholder="chromium"
              value={c.value}
              onChange={(e) =>
                setConfig((s) =>
                  s.map((v, n) =>
                    n === i ? { ...v, value: e.target.value } : v,
                  ),
                )
              }
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Удалить параметр"
              onClick={() => setConfig((s) => s.filter((_, n) => n !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          className="text-link"
          type="button"
          onClick={() => setConfig((s) => [...s, { key: "", value: "" }])}
        >
          + Добавить параметр
        </button>
        <div className="form-footer">
          {initial && (
            <AsyncButton
              type="button"
              variant="danger"
              onAction={async () => {
                await action("archive_environment", project.id, {
                  object_id: initial.id,
                  expected_version: initial.version,
                });
                saved();
              }}
            >
              В архив
            </AsyncButton>
          )}
          <Button type="submit">Сохранить</Button>
        </div>
      </Form>
    </Dialog>
  );
}
function GuideSettings() {
  const { project, reload } = useProject();
  const [guide, setGuide] = useState(project.guide || ""),
    [preview, setPreview] = useState(false);
  const manager = ["manager", "owner"].includes(project.role);
  return (
    <div className="stack">
      <div className="inline spaced">
        <div>
          <h2>Инструкции проекта для ИИ</h2>
          <p className="settings-hint">
            Документ входит в контекст MCP и пакеты выполнения проверок.
          </p>
        </div>
        <a
          className="button secondary"
          href={`/api/projects/${project.id}/ai.md`}
        >
          <Download size={14} />
          ai.md
        </a>
      </div>
      <div className="segmented" style={{ alignSelf: "flex-start" }}>
        <button
          className={!preview ? "active" : ""}
          onClick={() => setPreview(false)}
        >
          Редактор
        </button>
        <button
          className={preview ? "active" : ""}
          onClick={() => setPreview(true)}
        >
          Предпросмотр
        </button>
      </div>
      <Form
        onSubmit={async () => {
          await action("update_project_guide", project.id, {
            expected_version: project.version,
            content: guide,
          });
          reload();
        }}
      >
        {preview ? (
          <div className="panel guide-preview prose">
            <Markdown>{guide}</Markdown>
          </div>
        ) : (
          <Field
            label="Markdown-инструкции"
            hint="Расскажите агенту, где проверять приложение, как подготовить данные и какие результаты сохранять."
          >
            <textarea
              className="guide-editor"
              disabled={!manager}
              value={guide}
              onChange={(e) => setGuide(e.target.value)}
              spellCheck={false}
            />
          </Field>
        )}
        {manager && <Button type="submit">Сохранить инструкции</Button>}
      </Form>
    </div>
  );
}
const notificationLabels: Record<string, string> = {
  email: "Дополнительно отправлять по почте",
  comment_reply: "Ответы и упоминания",
  assignment: "Назначение проверки",
  proposal_submitted: "Новые предложения",
  proposal_decided: "Решения по предложениям",
  use_case_published: "Публикации юзер-кейсов",
  run_finished: "Завершение прогонов",
  run_cancelled: "Отмена прогонов",
  report_ready: "Готовность отчётов",
  role_changed: "Изменение прав",
};
function NotificationSettings() {
  const { project } = useProject(),
    toast = useToast();
  const data = useLoad(
    () =>
      action<{ preferences: Record<string, boolean>; email_enabled: boolean }>(
        "get_notification_preferences",
        project.id,
      ),
    [project.id],
  );
  const [preferences, set] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (data.data) set(data.data.preferences);
  }, [data.data]);
  return (
    <div className="settings-content">
      <h2>Личные уведомления в проекте</h2>
      <p className="settings-hint">
        Не уведомляем о ваших действиях. Результаты прогонов приходят сводкой.
      </p>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : (
        <Form
          onSubmit={async () => {
            await action("update_notification_preferences", project.id, {
              preferences,
            });
            toast("Настройки уведомлений сохранены");
          }}
        >
          <div className="notification-options">
            {Object.entries(notificationLabels)
              .filter(([key]) => key !== "email" || data.data?.email_enabled)
              .map(([key, label]) => (
                <label className="check-label" key={key}>
                  <input
                    type="checkbox"
                    checked={preferences[key] ?? key !== "email"}
                    onChange={(e) =>
                      set((p) => ({ ...p, [key]: e.target.checked }))
                    }
                  />
                  {label}
                </label>
              ))}
          </div>
          <Button type="submit">Сохранить</Button>
        </Form>
      )}
    </div>
  );
}
function AuditSettings() {
  const { project } = useProject();
  const data = useLoad(
    () =>
      action<{
        items: {
          id: string;
          created_at: string;
          actor_id: string;
          action: string;
          resource_id: string;
          metadata_: Record<string, string>;
        }[];
      }>("list_audit_events", project.id),
    [project.id],
  );
  const members = useLoad(
    () => action<{ items: Member[] }>("list_project_members", project.id),
    [project.id],
  );
  return (
    <>
      <h2 style={{ marginBottom: 20 }}>Журнал действий</h2>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : (
        <div className="panel table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Кто</th>
                <th>Действие</th>
                <th>Объект</th>
              </tr>
            </thead>
            <tbody>
              {data.data?.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <small>{date(a.created_at)}</small>
                  </td>
                  <td>
                    {members.data?.items.find((m) => m.user_id === a.actor_id)
                      ?.name || "Бывший участник"}
                  </td>
                  <td>
                    <span className="mono muted">{a.action}</span>
                    {a.metadata_.reason && (
                      <p className="actual-excerpt">{a.metadata_.reason}</p>
                    )}
                  </td>
                  <td>
                    <span className="mono muted">
                      {a.resource_id?.slice(0, 8) || "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
export function NotificationsPage({
  onNavigate,
  embedded = false,
}: { onNavigate?: () => void; embedded?: boolean } = {}) {
  const { project } = useProject(),
    navigate = useNavigate();
  const [unread, setUnread] = useState(false);
  const data = useLoad(
    () =>
      action<{
        items: {
          id: string;
          title: string;
          read: boolean;
          created_at: string;
          resource_type: string;
          resource_id: string;
        }[];
      }>("list_notifications", project.id, { unread_only: unread }),
    [project.id, unread],
  );
  useEffect(() => {
    const timer = setInterval(data.reload, 30000);
    return () => clearInterval(timer);
  }, [project.id]);
  async function open(n: NonNullable<typeof data.data>["items"][number]) {
    await action("mark_notifications_read", project.id, {
      notification_ids: [n.id],
    });
    data.reload();
    onNavigate?.();
    const paths: Record<string, string> = {
      use_case: "cases",
      proposal: "proposals",
      run: "runs",
      plan: "plans",
      report: "reports",
    };
    if (n.resource_type === "thread") {
      const t = await action<{ path: string }>(
        "get_comment_thread",
        project.id,
        { thread_id: n.resource_id },
      );
      navigate(t.path);
    } else if (n.resource_type === "project")
      navigate(`/p/${project.id}/settings`);
    else
      navigate(`/p/${project.id}/${paths[n.resource_type]}/${n.resource_id}`);
  }
  const readAction = (
    <AsyncButton
      variant="secondary"
      disabled={data.loading || !!data.error || !data.data?.items.length}
      onAction={async () => {
        await action("mark_notifications_read", project.id, {
          notification_ids: data.data?.items.map((n) => n.id) || [],
        });
        data.reload();
      }}
    >
      <Check size={14} aria-hidden="true" />
      Прочитать показанные
    </AsyncButton>
  );
  const description =
    "Здесь собраны ответы в обсуждениях, новые предложения и решения команды.";
  return (
    <div className={embedded ? "notifications-content" : "page"}>
      {embedded ? (
        <div className="notification-panel-intro">
          <p>{description}</p>
          {readAction}
        </div>
      ) : (
        <PageHead
          eyebrow="События проекта"
          title="Уведомления"
          description={description}
          actions={readAction}
        />
      )}
      <div className="toolbar">
        <div className="segmented">
          <button
            className={!unread ? "active" : ""}
            onClick={() => setUnread(false)}
          >
            Все
          </button>
          <button
            className={unread ? "active" : ""}
            onClick={() => setUnread(true)}
          >
            Непрочитанные
          </button>
        </div>
      </div>
      {data.loading && !data.data ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !data.data?.items.length ? (
        <div className="panel">
          <Empty
            title="Вы в курсе событий"
            description="Когда вам ответят в обсуждении или рассмотрят ваше предложение, вы увидите уведомление здесь."
            icon={<Bell size={26} />}
          />
        </div>
      ) : (
        <div className="panel">
          {data.data.items.map((n) => (
            <div
              className={
                "list-row notification-row " + (!n.read ? "unread" : "")
              }
              key={n.id}
            >
              <Bell size={17} />
              <div className="grow">
                <h3>{n.title}</h3>
                <p>{date(n.created_at)}</p>
              </div>
              <AsyncButton variant="ghost" onAction={() => open(n)}>
                Открыть
                <ChevronRight size={14} />
              </AsyncButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
type TokenInfo = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  project_ids: string[];
  expires_at: string;
  revoked: boolean;
  last_used_at: string | null;
};
export function ProfilePage() {
  const session = useSession();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const project = useProject()?.project;
  const [profileParams, setProfileParams] = useSearchParams();
  const requestedTab = profileParams.get("tab") || "profile";
  const tab = ["profile", "mcp", "skills"].includes(requestedTab) ? requestedTab : "profile";
  const setTab = (value: string) =>
    setProfileParams((previous) => {
      if (value === "profile") previous.delete("tab");
      else previous.set("tab", value);
      return previous;
    });
  const [name, setName] = useState(session.user.name),
    [create, setCreate] = useState(false),
    [raw, setRaw] = useState(""),
    [show, setShow] = useState(false);
  const tokens = useLoad(
    () => request<{ items: TokenInfo[] }>("/tokens"),
    [session.user.id],
  );
  const navigate = useNavigate();
  return (
    <div className="page">
      <Link className="back" to={project ? `/p/${project.id}/cases` : "/"}>
        <ArrowLeft size={14} />
        {project ? "К юзер-кейсам проекта" : "К проектам"}
      </Link>
      <PageHead
        eyebrow={session.user.email}
        title="Профиль и подключения"
        actions={
          <AsyncButton
            variant="secondary"
            onAction={async () => {
              await session.logout();
              navigate("/auth/login");
            }}
          >
            <LogOut size={14} />
            Выйти
          </AsyncButton>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "mcp", label: "MCP-доступ" },
          { key: "skills", label: "Навыки для агента" },
          { key: "profile", label: "Профиль" },
        ]}
      />
      {tab === "profile" ? (
        <div className="settings-content profile-settings">
          <section
            className="appearance-settings"
            aria-labelledby="appearance-title"
          >
            <h2 id="appearance-title">Оформление</h2>
            <p className="muted">
              Выберите тему для работы. Системная тема следует настройкам
              устройства.
            </p>
            <Form
              onSubmit={async () => {
                await request("/auth/profile", {
                  method: "PATCH",
                  body: JSON.stringify({ theme }),
                });
                await session.reloadUser();
                toast("Тема сохранена в профиле");
              }}
            >
              <fieldset className="theme-options">
                <legend className="sr-only">Тема оформления</legend>
                {(["light", "dark", "system"] as const).map((value) => (
                  <label className="theme-option" key={value}>
                    <span
                      className={`theme-preview ${value}`}
                      aria-hidden="true"
                    >
                      <i />
                      <b />
                      <b />
                      <b />
                    </span>
                    <span>
                      <input
                        type="radio"
                        name="theme"
                        value={value}
                        checked={theme === value}
                        onChange={() => setTheme(value)}
                      />
                      {
                        {
                          light: "Светлая",
                          dark: "Тёмная",
                          system: "Системная",
                        }[value]
                      }
                    </span>
                  </label>
                ))}
              </fieldset>
              <Button type="submit" variant="secondary">
                Сохранить тему
              </Button>
            </Form>
          </section>
          <Form
            onSubmit={async () => {
              await request("/auth/profile", {
                method: "PATCH",
                body: JSON.stringify({ name }),
              });
              await session.reloadUser();
              toast("Профиль сохранён");
            }}
          >
            <Field label="Имя">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Почта">
              <input disabled value={session.user.email} />
            </Field>
            <Button type="submit">Сохранить</Button>
          </Form>
        </div>
      ) : tab === "skills" ? (
        <SkillsPanel onOpenAccess={() => setTab("mcp")} />
      ) : (
        <div className="stack">
          <div className="mcp-connection">
            <div className="mcp-logo">
              <Code2 size={25} />
            </div>
            <div className="grow">
              <h2>Подключите своего ИИ-агента</h2>
              <p>
                Добавьте адрес MCP-сервера и персональный токен. Доступ
                ограничивается ролью, разрешениями и выбранными проектами.
              </p>
              <code>{location.origin}/mcp/</code>
            </div>
            <AsyncButton
              variant="secondary"
              onAction={() =>
                navigator.clipboard.writeText(location.origin + "/mcp/")
              }
            >
              <Copy size={14} />
              Адрес
            </AsyncButton>
          </div>
          <details className="connection-example">
            <summary>Пример конфигурации MCP-клиента</summary>
            <pre>
              {JSON.stringify(
                {
                  mcpServers: {
                    ucaselab: {
                      type: "http",
                      url: location.origin + "/mcp/",
                      headers: { Authorization: "Bearer <ВАШ_ТОКЕН>" },
                    },
                  },
                },
                null,
                2,
              )}
            </pre>
            <small>
              Сервер использует Streamable HTTP и персональные Bearer-токены.
            </small>
          </details>
          <div className="inline spaced">
            <h2>Персональные токены</h2>
            <Button onClick={() => setCreate(true)}>
              <Plus size={15} />
              Создать токен
            </Button>
          </div>
          {tokens.loading ? (
            <Loading />
          ) : tokens.error ? (
            <ErrorState error={tokens.error} retry={tokens.reload} />
          ) : !tokens.data?.items.length ? (
            <div className="panel">
              <Empty
                title="Выдайте агенту доступ"
                description="Создайте отдельный токен для каждого агента. Ограничьте его проектами и отзывайте при необходимости."
                icon={<KeyRound size={26} />}
              />
            </div>
          ) : (
            <div className="panel table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Токен</th>
                    <th>Проекты и разрешения</th>
                    <th>Срок и активность</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tokens.data.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.name}</strong>
                        <p>
                          <small className="mono">{t.prefix}…</small>
                        </p>
                        {t.revoked && <Badge status="cancelled">Отозван</Badge>}
                      </td>
                      <td>
                        <small>
                          {t.project_ids
                            .map(
                              (id) =>
                                session.projects.find((p) => p.id === id)
                                  ?.name || "Недоступный проект",
                            )
                            .join(", ") || "Без проектов"}
                        </small>
                        <div className="token-scopes">
                          {t.scopes.join(", ")}
                        </div>
                      </td>
                      <td>
                        <small>
                          До {date(t.expires_at)}
                          <br />
                          Использование: {date(t.last_used_at)}
                        </small>
                      </td>
                      <td>
                        {!t.revoked && (
                          <AsyncButton
                            variant="ghost"
                            onAction={async () => {
                              await request("/tokens/" + t.id, {
                                method: "DELETE",
                              });
                              tokens.reload();
                            }}
                          >
                            Отозвать
                          </AsyncButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {create && (
        <TokenForm
          close={() => setCreate(false)}
          created={(token) => {
            setCreate(false);
            setRaw(token);
            tokens.reload();
          }}
        />
      )}
      {raw && (
        <Dialog
          title="Сохраните токен сейчас"
          onClose={() => {
            setRaw("");
            setShow(false);
          }}
        >
          <div className="stack">
            <div className="note">
              Токен показывается один раз. Сохраните его в защищённом хранилище.
            </div>
            <div className="inline">
              <input
                className="input mono grow"
                aria-label="Созданный MCP-токен"
                readOnly
                type={show ? "text" : "password"}
                value={raw}
              />
              <button
                className="icon-button"
                aria-label="Показать или скрыть токен"
                onClick={() => setShow((v) => !v)}
              >
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <AsyncButton onAction={() => navigator.clipboard.writeText(raw)}>
              <Copy size={14} />
              Скопировать токен
            </AsyncButton>
            <Button
              variant="secondary"
              onClick={() => {
                setRaw("");
                setShow(false);
              }}
            >
              Токен сохранён
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
function TokenForm({
  close,
  created,
}: {
  close: () => void;
  created: (raw: string) => void;
}) {
  const { projects } = useSession();
  const selectedProject = useProject()?.project;
  const [name, setName] = useState(""),
    [days, setDays] = useState(90),
    [projectIds, setProjects] = useState<string[]>(
      selectedProject
        ? [selectedProject.id]
        : projects
            .filter((p) => !p.archived)
            .slice(0, 1)
            .map((p) => p.id),
    ),
    [scopes, setScopes] = useState<string[]>(["projects:read"]);
  const data = useLoad(
    () => request<{ available_scopes: string[] }>("/auth/me"),
    [],
  );
  const presets: Record<string, string[]> = {
    read: ["projects:read"],
    author: [
      "projects:read",
      "use_cases:write",
      "use_cases:publish",
      "specifications:write",
      "accounts:write",
      "proposals:write",
      "comments:write",
    ],
    tester: [
      "projects:read",
      "runs:write",
      "plans:write",
      "reports:write",
      "comments:write",
      "secrets:read",
    ],
    review: ["projects:read", "proposals:write", "proposals:review"],
    developer: ["projects:read", "proposals:write", "comments:write"],
    full: data.data?.available_scopes || [],
  };
  return (
    <Dialog title="Новый MCP-токен" onClose={close} wide>
      <Form
        onSubmit={async () => {
          const result = await request<{ token: string }>("/tokens", {
            method: "POST",
            body: JSON.stringify({
              name,
              expires_days: days,
              project_ids: projectIds,
              scopes,
            }),
          });
          created(result.token);
        }}
      >
        <div className="field-row">
          <Field label="Название">
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Личный агент · разработка"
            />
          </Field>
          <Field label="Срок действия">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={7}>7 дней</option>
              <option value={30}>30 дней</option>
              <option value={90}>90 дней</option>
              <option value={365}>365 дней</option>
            </select>
          </Field>
        </div>
        <div className="token-editor-grid">
          <div>
            <h3>Доступные проекты</h3>
            <p className="settings-hint">Роль проверяется при каждом вызове.</p>
            {projects
              .filter((p) => !p.archived)
              .map((p) => (
                <label className="plan-check" key={p.id}>
                  <input
                    type="checkbox"
                    checked={projectIds.includes(p.id)}
                    onChange={(e) =>
                      setProjects((s) =>
                        e.target.checked
                          ? [...s, p.id]
                          : s.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <span>
                    <strong>{p.name}</strong>
                    <small>{roles[p.role]}</small>
                  </span>
                </label>
              ))}
          </div>
          <div>
            <h3>Разрешения токена</h3>
            <div className="inline scope-presets">
              {[
                ["read", "Чтение"],
                ["author", "Автор"],
                ["tester", "Тестирование"],
                ["developer", "Разработка"],
                ["review", "Предложения"],
                ["full", "Все"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="tag"
                  onClick={() => setScopes(presets[key])}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="scope-list">
              {data.data?.available_scopes.map((s) => (
                <label className="check-label" key={s}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((v) =>
                        e.target.checked ? [...v, s] : v.filter((t) => t !== s),
                      )
                    }
                  />
                  <span className="mono">{s}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        {scopes.includes("secrets:read") && (
          <div className="note">
            Агент сможет получить пароли тестовых аккаунтов, если роль участника
            тоже позволяет это.
          </div>
        )}
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button type="submit" disabled={!scopes.length}>
            Создать токен
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
function SkillsPanel({ onOpenAccess }: { onOpenAccess: () => void }) {
  type Skill = {
    name: string;
    version: string;
    description: string;
    archive: string;
    sha256: string;
    size_bytes: number;
  };
  const data = useLoad(() => action<{ skills: Skill[] }>("list_skills"), []);
  const [selected, setSelected] = useState<{
    name: string;
    content: string;
  } | null>(null);
  const { projects } = useSession();
  const activeProject = useProject()?.project;
  const guideProjects = activeProject
    ? [activeProject]
    : projects.filter((p) => !p.archived);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const setupLink = location.origin + "/ai.md";
  const names: Record<string, string> = {
    "ucaselab-platform": "Работа с платформой",
    "ucaselab-read-use-cases": "Чтение юзер-кейсов",
    "ucaselab-author-use-cases": "Создание и заполнение",
    "ucaselab-test-use-cases": "Проведение проверок",
    "ucaselab-propose-changes": "Предложения изменений",
    "ucaselab-review-proposals": "Аудит предложений",
    "ucaselab-apply-proposals": "Кейсы из предложений",
    "ucaselab-case-plans": "Планы и отчёты",
    "ucaselab-discussions": "Обсуждения",
  };
  return (
    <div className="stack">
      <section className="agent-setup" aria-labelledby="agent-setup-title">
        <h2 id="agent-setup-title">Одна ссылка для вашего ИИ</h2>
        <p className="agent-setup-description">
          Отправьте её агенту. Внутри — инструкция подключения к MCP и каталог
          навыков: агент сможет выбрать и скачать нужные для задачи.
        </p>
        <div className="agent-setup-link">
          <input
            aria-label="Ссылка для подключения ИИ"
            readOnly
            value={setupLink}
            onFocus={(event) => event.currentTarget.select()}
            spellCheck={false}
          />
          <AsyncButton
            onAction={async () => {
              try {
                await navigator.clipboard.writeText(setupLink);
              } catch {
                throw new Error(
                  "Не удалось скопировать автоматически. Выделите ссылку и скопируйте её вручную.",
                );
              }
              setCopied(true);
              toast("Ссылка для ИИ скопирована");
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "Ссылка скопирована" : "Скопировать ссылку для ИИ"}
          </AsyncButton>
        </div>
        <div className="agent-setup-details">
          <p>
            Ссылка открывается без входа. Для работы с проектами передайте
            агенту персональный MCP-токен отдельно.
          </p>
          <div className="agent-setup-actions">
            <a href={setupLink} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} />
              Открыть инструкцию
            </a>
            <button type="button" onClick={onOpenAccess}>
              Настроить MCP-доступ
            </button>
          </div>
        </div>
      </section>
      {guideProjects.length > 0 && (
        <div className="inline">
          <span className="muted" style={{ fontSize: 12 }}>
            Инструкции проекта:
          </span>
          {guideProjects.map((p) => (
            <a
              className="button secondary"
              key={p.id}
              href={`/api/projects/${p.id}/ai.md`}
            >
              <Download size={13} />
              {p.name} · ai.md
            </a>
          ))}
        </div>
      )}
      <div className="agent-skills-heading">
        <h2>Отдельные навыки</h2>
        <p>
          Читайте и скачивайте пакеты здесь, если устанавливаете их вручную.
        </p>
      </div>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : (
        <div className="grid-cards">
          {data.data?.skills.map((s) => (
            <div className="resource-card skill-card" key={s.name}>
              <div className="inline spaced">
                <FileText size={22} color="#859ddd" />
                <span className="tag">v{s.version}</span>
              </div>
              <h3>{names[s.name] || s.name}</h3>
              <p>{s.description}</p>
              <div className="card-footer">
                <AsyncButton
                  variant="ghost"
                  onAction={async () =>
                    setSelected(
                      await action("get_skill", null, { name: s.name }),
                    )
                  }
                >
                  Прочитать
                </AsyncButton>
                <a
                  className="button secondary"
                  href={"/api/skills/" + s.archive}
                >
                  <Download size={13} />
                  ZIP
                </a>
              </div>
              <small className="mono skill-hash" title={"SHA-256: " + s.sha256}>
                {s.name} · {Math.ceil(s.size_bytes / 1024)} КБ
              </small>
            </div>
          ))}
        </div>
      )}
      {selected && (
        <Dialog
          title={names[selected.name] || selected.name}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="prose">
            <Markdown>{selected.content}</Markdown>
          </div>
        </Dialog>
      )}
    </div>
  );
}
