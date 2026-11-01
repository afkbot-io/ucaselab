import { ActivityPanel } from "./activity-panel";
import { useProjectAttention, type Attention } from "./attention";
import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  History,
  Bell,
  BookOpen,
  ChevronRight,
  ChevronsUpDown,
  Check,
  ClipboardList,
  FileBarChart2,
  FolderOpen,
  Layers2,
  Lightbulb,
  Menu,
  Plus,
  Search,
  Settings,
  Shield,
  Users,
  ArrowUpRight,
} from "lucide-react";
import { action, auth, request } from "./api";
import { AuthPage, Brand } from "./auth";
import { useTheme } from "./theme";
import { Session, ProjectContext, useSession } from "./context";
import type { Project, User } from "./types";
import { roles } from "./types";
import {
  AsyncButton,
  Button,
  Dialog,
  Empty,
  ErrorState,
  Field,
  Form,
  Loading,
  PageHead,
  useLoad,
  useDebounced,
} from "./ui";
import { RunPage } from "./run-workspace";
import { CasesPage, CasePage } from "./case-pages";
import {
  PlansPage,
  PlanPage,
  RunsPage,
  ReportsPage,
  ReportPage,
} from "./run-pages";
import {
  ProposalsPage,
  ProposalPage,
  ResourcesPage,
  SettingsPage,
  NotificationsPage,
  ProfilePage,
} from "./project-pages";

for (const key of Object.keys(sessionStorage)) {
  if (key.startsWith("testcase:")) {
    const replacement = key.replace("testcase:", "ucaselab:");
    if (!sessionStorage.getItem(replacement))
      sessionStorage.setItem(replacement, sessionStorage.getItem(key)!);
    sessionStorage.removeItem(key);
  }
}

export function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const location = useLocation();
  const { setTheme } = useTheme();
  useEffect(() => {
    if (user) setTheme(user.preferences?.theme || "system");
  }, [user?.id, user?.preferences?.theme, setTheme]);
  useEffect(() => {
    request<{ user: User }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [version]);
  const projects = useLoad(
    () =>
      user
        ? action<{ items: Project[] }>("list_projects")
        : Promise.resolve({ items: [] }),
    [user?.id],
  );
  if (location.pathname.startsWith("/auth/"))
    return (
      <AuthPage
        key={location.pathname + location.search}
        onLogin={async () => {
          const r = await request<{ user: User }>("/auth/me");
          setUser(r.user);
          setLoading(false);
          setVersion((n) => n + 1);
        }}
      />
    );
  if (loading) return <Loading />;
  if (!user) {
    if (location.pathname.startsWith("/invite"))
      sessionStorage.setItem(
        "after_login",
        location.pathname + location.search,
      );
    return <Navigate to="/auth/login" replace />;
  }
  const session = {
    user,
    projects: projects.data?.items || [],
    reloadProjects: projects.reload,
    reloadUser: async () =>
      setUser((await request<{ user: User }>("/auth/me")).user),
    logout: async () => {
      await auth("logout", {});
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith("ucaselab:"))
        .forEach((key) => sessionStorage.removeItem(key));
      setUser(null);
    },
  };
  return (
    <Session.Provider value={session}>
      <Routes>
        <Route path="/" element={<ProjectsPage loading={projects.loading} />} />
        <Route
          path="/profile"
          element={<ProfileRoute loading={projects.loading} />}
        />
        <Route path="/invite" element={<Invitation />} />
        <Route path="/p/:projectId/*" element={<Workspace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Session.Provider>
  );
}

function ProfileRoute({ loading }: { loading: boolean }) {
  const session = useSession();
  const location = useLocation();
  if (loading) return <Loading />;
  const selected = session.projects.find(
    (p) =>
      p.id === sessionStorage.getItem("ucaselab:lastProject") && !p.archived,
  );
  if (selected) return <Navigate to={`/p/${selected.id}/profile${location.search}${location.hash}`} replace />;
  return (
    <>
      <Topbar />
      <main className="profile-page" id="main-content" tabIndex={-1}>
        <ProfilePage />
      </main>
    </>
  );
}

function ProjectForm({ close }: { close: () => void }) {
  const [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [description, setDescription] = useState("");
  const navigate = useNavigate(),
    session = useSession();
  return (
    <Dialog title="Новый проект" onClose={close}>
      <Form
        onSubmit={async () => {
          const p = await action<Project>("create_project", null, {
            name,
            key,
            description,
          });
          session.reloadProjects();
          close();
          navigate(`/p/${p.id}/cases`);
        }}
      >
        <Field label="Название">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, личный кабинет"
            maxLength={160}
          />
        </Field>
        <Field
          label="Ключ проекта"
          hint="2–10 латинских букв или цифр. Используется в номерах кейсов: APP-UC-1."
        >
          <input
            required
            value={key}
            onChange={(e) =>
              setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
            }
            pattern="[A-Z][A-Z0-9]{1,9}"
            placeholder="APP"
            maxLength={10}
          />
        </Field>
        <Field label="Описание">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Что проверяем в этом проекте"
          />
        </Field>
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button type="submit">Создать проект</Button>
        </div>
      </Form>
    </Dialog>
  );
}

function Topbar({
  project,
  onMenu,
  attention,
}: {
  project?: Project;
  onMenu?: () => void;
  attention?: Attention | null;
}) {
  const session = useSession(),
    [create, setCreate] = useState(false),
    [search, setSearch] = useState(false),
    [switcher, setSwitcher] = useState(false),
    [panel, setPanel] = useState<"activity" | "notifications" | null>(null);
  const selectedProject =
    project ||
    session.projects.find(
      (p) => p.id === sessionStorage.getItem("ucaselab:lastProject"),
    );
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && project) {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [project?.id]);
  return (
    <>
      <a className="skip-link" href="#main-content">
        К содержимому
      </a>
      <header className="topbar">
        {onMenu && (
          <button
            className="icon-button mobile-menu"
            aria-label="Меню"
            aria-haspopup="dialog"
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              onMenu?.();
            }}
          >
            <Menu size={20} />
          </button>
        )}
        <Link
          to={selectedProject ? `/p/${selectedProject.id}/cases` : "/"}
          aria-label={project ? "Юзер-кейсы выбранного проекта" : "Проекты"}
        >
          <Brand />
        </Link>
        <div className="project-picker">
          {project && (
            <span className="project-avatar">{project.key.slice(0, 2)}</span>
          )}
          <button
            className="project-switch-trigger"
            aria-label="Выбрать проект"
            aria-haspopup="dialog"
            onClick={() => setSwitcher(true)}
          >
            <span>{project?.name || "Выбрать проект"}</span>
            <ChevronsUpDown size={14} />
          </button>
        </div>
        <div className="topbar-right">
          {project && (
            <>
              <button
                className="search-trigger"
                onClick={() => setSearch(true)}
                aria-label="Поиск по проекту"
              >
                <Search size={16} />
                <span>Найти в проекте</span>
                <kbd>⌘ K</kbd>
              </button>
              <button
                className="icon-button"
                title="История изменений"
                aria-label={
                  attention?.unread_activity
                    ? `История изменений: ${attention.unread_activity} непрочитанных`
                    : "История изменений"
                }
                aria-haspopup="dialog"
                aria-expanded={panel === "activity"}
                onClick={() => setPanel("activity")}
              >
                <History size={18} />
                {!!attention?.unread_activity && (
                  <span className="notification-count" aria-hidden="true">
                    {attention.unread_activity > 99
                      ? "99+"
                      : attention.unread_activity}
                  </span>
                )}
              </button>
              <Link
                className="icon-button"
                to={`/p/${project.id}/notifications`}
                aria-haspopup="dialog"
                aria-expanded={panel === "notifications"}
                onClick={(e) => {
                  e.preventDefault();
                  setPanel("notifications");
                }}
                aria-label={
                  attention?.unread_notifications
                    ? `Уведомления: ${attention.unread_notifications} непрочитанных`
                    : "Уведомления"
                }
                title="Уведомления"
              >
                <Bell size={18} />
                {!!attention?.unread_notifications && (
                  <span className="notification-count" aria-hidden="true">
                    {attention.unread_notifications > 99
                      ? "99+"
                      : attention.unread_notifications}
                  </span>
                )}
              </Link>
            </>
          )}
          <Link
            to={
              selectedProject ? `/p/${selectedProject.id}/profile` : "/profile"
            }
            className="avatar"
            title={session.user.name}
          >
            {session.user.name.slice(0, 2).toUpperCase()}
          </Link>
        </div>
      </header>
      {switcher && (
        <ProjectSwitcher
          selected={project?.id}
          close={() => setSwitcher(false)}
          create={() => {
            setSwitcher(false);
            setCreate(true);
          }}
        />
      )}
      {panel && project && (
        <Dialog
          title={panel === "activity" ? "История изменений" : "Уведомления"}
          className="discussion-drawer activity-drawer"
          onClose={() => setPanel(null)}
          focusField={false}
        >
          <div className="side-panel-scroll" tabIndex={0} role="region" aria-label="Содержимое панели">
            {panel === "activity" ? (
              <ActivityPanel close={() => setPanel(null)} />
            ) : (
              <NotificationsPage embedded onNavigate={() => setPanel(null)} />
            )}
          </div>
        </Dialog>
      )}
      {create && <ProjectForm close={() => setCreate(false)} />}
      {search && project && (
        <SearchDialog project={project} close={() => setSearch(false)} />
      )}
    </>
  );
}

function ProjectSwitcher({
  selected,
  close,
  create,
}: {
  selected?: string;
  close: () => void;
  create: () => void;
}) {
  const [query, setQuery] = useState("");
  const data = useLoad(
    () =>
      action<{ items: Project[]; total: number; next_offset: number | null }>(
        "list_projects",
        null,
        { search: query, archived: false, sort: "title", limit: 50 },
      ),
    [query],
  );
  const [more, setMore] = useState<Project[]>([]),
    [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    setMore([]);
    setOffset(data.data?.next_offset ?? null);
  }, [data.data]);
  return (
    <Dialog title="Выбрать проект" onClose={close}>
      <div className="search-input project-switch-search">
        <Search size={16} />
        <input
          aria-label="Поиск проекта"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Название или ключ проекта…"
          autoComplete="off"
        />
      </div>
      <div className="project-switch-list">
        {data.loading ? (
          <Loading />
        ) : data.error ? (
          <ErrorState error={data.error} retry={data.reload} />
        ) : !data.data?.items.length ? (
          <Empty
            title="Проектов не найдено"
            description="Попробуйте другое название или создайте проект."
          />
        ) : (
          [...data.data.items, ...more].map((p) => (
            <Link
              key={p.id}
              className={
                "project-switch-row " + (p.id === selected ? "selected" : "")
              }
              to={`/p/${p.id}/cases`}
              onClick={close}
            >
              <span className="project-avatar">{p.key.slice(0, 2)}</span>
              <span className="grow">
                <strong>{p.name}</strong>
                <small>
                  {p.key} · {roles[p.role]}
                </small>
              </span>
              {p.id === selected ? (
                <Check size={17} />
              ) : (
                <ChevronRight size={16} />
              )}
            </Link>
          ))
        )}
        {offset !== null && (
          <AsyncButton
            variant="ghost"
            onAction={async () => {
              const r = await action<{
                items: Project[];
                next_offset: number | null;
              }>("list_projects", null, {
                search: query,
                archived: false,
                limit: 50,
                offset,
              });
              setMore((v) => [...v, ...r.items]);
              setOffset(r.next_offset);
            }}
          >
            Показать ещё
          </AsyncButton>
        )}
      </div>
      <div className="project-switch-footer">
        <Link to="/" onClick={close}>
          <Layers2 size={16} />
          Все проекты
        </Link>
        <Button onClick={create}>
          <Plus size={15} />
          Создать проект
        </Button>
      </div>
    </Dialog>
  );
}

function SearchDialog({
  project,
  close,
}: {
  project: Project;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query);
  type Entry = {
    id: string;
    key?: string;
    title?: string;
    name?: string;
    description?: string;
  };
  type Results = {
    use_cases: Entry[];
    specifications: Entry[];
    proposals: Entry[];
    plans: Entry[];
    accounts: Entry[];
    totals: Record<string, number>;
  };
  const data = useLoad(
    () =>
      search.trim()
        ? action<Results>("search_project", project.id, {
            query: search,
            limit: 10,
          })
        : Promise.resolve(null),
    [project.id, search],
  );
  const groups = [
    ["use_cases", "Юзер-кейсы", "cases", FolderOpen],
    ["specifications", "Спецификации", "specifications", BookOpen],
    ["plans", "Кейс-планы", "plans", ClipboardList],
    ["proposals", "Предложения", "proposals", Lightbulb],
    ["accounts", "Тестовые аккаунты", "accounts", Users],
  ] as const;
  const found = data.data && Object.values(data.data.totals).some(Boolean);
  return (
    <Dialog title="Найти в проекте" onClose={close}>
      <Field label="Название, номер или фраза из описания">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Регистрация, APP-UC-1, вход по коду…"
          autoComplete="off"
        />
      </Field>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : found ? (
        <div className="global-search-groups">
          {groups.map(([key, label, path, Icon]) =>
            data.data![key]?.length ? (
              <section key={key}>
                <div className="inline spaced">
                  <h3>
                    {label}{" "}
                    <span className="count">{data.data!.totals[key]}</span>
                  </h3>
                  <Link
                    className="text-link"
                    to={`/p/${project.id}/${path}?q=${encodeURIComponent(search)}`}
                    onClick={close}
                  >
                    Все результаты
                  </Link>
                </div>
                {data.data![key].map((v) => (
                  <Link
                    className="search-result-row"
                    key={v.id}
                    to={
                      path === "specifications" || path === "accounts"
                        ? `/p/${project.id}/${path}?open=${v.id}`
                        : `/p/${project.id}/${path}/${v.id}`
                    }
                    onClick={close}
                  >
                    <Icon size={17} />
                    <span>
                      <strong>{v.title || v.name}</strong>
                      {v.key && <small>{v.key}</small>}
                    </span>
                    <ChevronRight size={14} />
                  </Link>
                ))}
              </section>
            ) : null,
          )}
        </div>
      ) : (
        <Empty
          title={search ? "Ничего не найдено" : "Что хотите найти?"}
          description={
            search
              ? "Попробуйте более короткий запрос или другое слово из описания."
              : "Ищем по кейсам, спецификациям, кейс-планам, предложениям и аккаунтам выбранного проекта."
          }
        />
      )}
    </Dialog>
  );
}

function ProjectsPage({ loading }: { loading: boolean }) {
  const { projects } = useSession(),
    [create, setCreate] = useState(false),
    [archive, setArchive] = useState(false);
  return (
    <>
      <Topbar />
      <main className="projects-page page" id="main-content" tabIndex={-1}>
        <PageHead
          eyebrow="Рабочее пространство"
          title="Ваши проекты"
          description="Откройте проект, чтобы найти сценарии, запустить проверки или посмотреть результаты команды."
          actions={
            <Button onClick={() => setCreate(true)}>
              <Plus size={16} />
              Новый проект
            </Button>
          }
        />
        <div className="toolbar">
          <div className="segmented">
            <button
              className={!archive ? "active" : ""}
              onClick={() => setArchive(false)}
            >
              Активные
            </button>
            <button
              className={archive ? "active" : ""}
              onClick={() => setArchive(true)}
            >
              Архив
            </button>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {projects.filter((p) => p.archived === archive).length} проектов
          </span>
        </div>
        {loading ? (
          <Loading />
        ) : !projects.filter((p) => p.archived === archive).length ? (
          <div className="panel">
            <Empty
              title={
                archive ? "В архиве пока пусто" : "Начните с первого проекта"
              }
              description="Создайте проект для сайта или приложения. Описывайте сценарии вместе с командой или поручите это ИИ-агенту."
              action={
                !archive && (
                  <Button onClick={() => setCreate(true)}>
                    <Plus size={16} />
                    Создать проект
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div className="grid-cards">
            {projects
              .filter((p) => p.archived === archive)
              .map((p) => (
                <div className="resource-card project-card" key={p.id}>
                  <div className="inline spaced">
                    <span className="project-tile">{p.key.slice(0, 2)}</span>
                    <span className="tag">{roles[p.role]}</span>
                  </div>
                  <h3>{p.name}</h3>
                  <p>{p.description || "Описание проекта ещё не добавлено"}</p>
                  <div className="card-footer">
                    <span className="mono muted">{p.key}</span>
                    {p.archived ? (
                      <RestoreProject project={p} />
                    ) : (
                      <Link
                        className="text-link inline"
                        to={`/p/${p.id}/cases`}
                      >
                        Открыть
                        <ArrowUpRight size={14} />
                      </Link>
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}
        {create && <ProjectForm close={() => setCreate(false)} />}
      </main>
    </>
  );
}
function RestoreProject({ project }: { project: Project }) {
  const session = useSession();
  return project.role === "owner" ? (
    <AsyncButton
      variant="secondary"
      onAction={async () => {
        await action("archive_project", project.id, {
          expected_version: project.version,
          archived: false,
        });
        session.reloadProjects();
      }}
    >
      Восстановить
    </AsyncButton>
  ) : (
    <small>Обратитесь к руководителю</small>
  );
}

function Workspace() {
  const { projectId } = useParams(),
    session = useSession(),
    [menu, setMenu] = useState(false),
    location = useLocation();
  const attention = useProjectAttention(
    projectId!,
    session.projects.find((p) => p.id === projectId)?.role || "developer",
  );
  const data = useLoad(
    () => action<Project>("get_project_context", projectId),
    [projectId],
  );
  useEffect(() => setMenu(false), [location.pathname]);
  useEffect(() => {
    if (projectId) sessionStorage.setItem("ucaselab:lastProject", projectId);
  }, [projectId]);
  if ((!data.data || data.data.id !== projectId) && !data.error)
    return (
      <>
        <Topbar />
        <Loading />
      </>
    );
  if (data.error)
    return (
      <>
        <Topbar />
        <ErrorState error={data.error} retry={data.reload} />
        <div style={{ textAlign: "center" }}>
          <Link className="text-link" to="/">
            К проектам
          </Link>
        </div>
      </>
    );
  const project = {
    ...session.projects.find((p) => p.id === projectId),
    ...data.data,
  } as Project;
  if (!project?.id) return <Loading />;
  const nav = [
    ["cases", "Юзер-кейсы", FolderOpen],
    ["plans", "Кейс-планы", ClipboardList],
    ["runs", "Проверки", Shield],
    ["proposals", "Предложения", Lightbulb],
    ["specifications", "Спецификации", BookOpen],
    ["accounts", "Тестовые аккаунты", Users],
    ["reports", "Отчёты", FileBarChart2],
  ] as const;
  const mcpActive = location.pathname === `/p/${project.id}/profile` &&
    ["mcp", "skills"].includes(new URLSearchParams(location.search).get("tab") || "profile");
  const navigation = (
    <nav className="sidebar" aria-label="Основная навигация">
      <span className="nav-caption">ПРОЕКТ</span>
      {nav.map(([path, label, Icon]) => (
        <NavLink
          key={path}
          className={({ isActive }) => "nav-link " + (isActive ? "active" : "")}
          to={`/p/${project.id}/${path}`}
          aria-label={
            attention?.sections[path]
              ? `${label}: ${attention.sections[path]} требуют внимания`
              : label
          }
          onClick={() => setMenu(false)}
        >
          <Icon size={17} />
          <span>{label}</span>
          {!!attention?.sections[path] && (
            <span className="nav-count" title="Требуют внимания">
              {attention.sections[path] > 99 ? "99+" : attention.sections[path]}
            </span>
          )}
        </NavLink>
      ))}
      <div className="sidebar-bottom">
        <NavLink
          className={({ isActive }) => "nav-link " + (isActive ? "active" : "")}
          to={`/p/${project.id}/settings`}
          aria-label={
            attention?.sections.settings
              ? `Настройки проекта: ${attention.sections.settings} требуют внимания`
              : "Настройки проекта"
          }
          onClick={() => setMenu(false)}
        >
          <Settings size={17} />
          <span>Настройки проекта</span>
          {!!attention?.sections.settings && (
            <span className="nav-count" title="Требуют внимания">
              {attention.sections.settings > 99
                ? "99+"
                : attention.sections.settings}
            </span>
          )}
        </NavLink>
        <Link
          className={"nav-link " + (mcpActive ? "active" : "")}
          aria-current={mcpActive ? "page" : undefined}
          to={`/p/${project.id}/profile?tab=mcp`}
          onClick={() => setMenu(false)}
        >
          <Layers2 size={17} />
          MCP и навыки
        </Link>
        <div className="sidebar-note">
          {roles[project.role]}
          <br />
          {session.user.email}
        </div>
      </div>
    </nav>
  );
  return (
    <ProjectContext.Provider
      value={{
        project,
        reload: () => {
          data.reload();
          session.reloadProjects();
        },
      }}
    >
      <Topbar
        project={project}
        attention={attention}
        onMenu={() => setMenu((v) => !v)}
      />
      <div className="layout">
        {navigation}
        {menu && (
          <Dialog
            title="Навигация проекта"
            className="navigation-drawer"
            focusField={false}
            onClose={() => setMenu(false)}
          >
            {navigation}
          </Dialog>
        )}
        <main className="workspace" id="main-content" tabIndex={-1}>
          <Routes>
            <Route path="cases" element={<CasesPage />} />
            <Route path="cases/:caseId" element={<CasePage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="plans/:planId" element={<PlanPage />} />
            <Route path="runs" element={<RunsPage />} />
            <Route path="runs/:runId" element={<RunPage />} />
            <Route path="proposals" element={<ProposalsPage />} />
            <Route path="proposals/:proposalId" element={<ProposalPage />} />
            <Route
              path="specifications"
              element={<ResourcesPage kind="specifications" />}
            />
            <Route
              path="accounts"
              element={<ResourcesPage kind="accounts" />}
            />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/:reportId" element={<ReportPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="cases" replace />} />
          </Routes>
        </main>
      </div>
    </ProjectContext.Provider>
  );
}

function Invitation() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate(),
    session = useSession();
  const token = new URLSearchParams(useLocation().search).get("token");
  return (
    <>
      <Topbar />
      <main className="page" id="main-content" tabIndex={-1}>
        <PageHead
          title="Приглашение в проект"
          description="После принятия приглашения проект появится в вашем рабочем пространстве."
          actions={
            <Button
              disabled={done || !token}
              onClick={async () => {
                try {
                  setDone(true);
                  const r = await auth("accept-invitation", { token });
                  session.reloadProjects();
                  navigate(`/p/${r.project_id}/cases`);
                } catch (e) {
                  setError((e as Error).message);
                  setDone(false);
                }
              }}
            >
              Принять приглашение
            </Button>
          }
        />
        {!token && (
          <div className="note">
            Откройте ссылку приглашения, которую вам прислал участник проекта.
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </main>
    </>
  );
}
