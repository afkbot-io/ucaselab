import { DiscussionButton } from "./discussions";
import { useId, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Archive,
  Check,
  ChevronRight,
  ClipboardList,
  Download,
  FileBarChart2,
  Play,
  Plus,
  X,
} from "lucide-react";
import { action } from "./api";
import { CasePicker, SearchPicker, type Choice } from "./pickers";
import { useProject } from "./context";
import type {
  Environment,
  Member,
  Plan,
  PlanContent,
  PlanItem,
  Report,
  Run,
  RunItem,
  Summary,
  UseCase,
  CaseSource,
} from "./types";
import { caseVersion, statusLabels } from "./types";
import { CaseSourceField, ReadinessSummary } from "./run-preparation";
import {
  quantity,
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
  percent,
  useLoad,
} from "./ui";

function SummaryBar({ summary }: { summary: Summary }) {
  return (
    <div className="summary-grid">
      <div className="summary-stat">
        <span>Выбрано проверок</span>
        <strong>{summary.selected}</strong>
      </div>
      <div className="summary-stat passed">
        <span>Успешно</span>
        <strong>{summary.counts.passed}</strong>
      </div>
      <div className="summary-stat failed">
        <span>Ошибки приложения</span>
        <strong>{summary.counts.failed}</strong>
      </div>
      <div className="summary-stat scenario_issue">
        <span>Неточности сценария</span>
        <strong>{summary.counts.scenario_issue || 0}</strong>
      </div>
      <div className="summary-stat">
        <span>Не удалось проверить</span>
        <strong>{summary.counts.blocked}</strong>
      </div>
      <div className="summary-stat">
        <span>Покрытие</span>
        <strong>{percent(summary.coverage)}</strong>
      </div>
      <div className="summary-stat">
        <span>Успех среди проверенных</span>
        <strong>{percent(summary.pass_rate)}</strong>
      </div>
    </div>
  );
}
function Progress({ summary }: { summary: Summary }) {
  return (
    <div
      className="progress-track"
      title={`Покрытие ${percent(summary.coverage)}`}
    >
      {(
        ["passed", "failed", "scenario_issue", "blocked", "skipped"] as const
      ).map((s) => (
        <span
          key={s}
          className={s}
          style={{
            width:
              (summary.selected
                ? (100 * (summary.counts[s] || 0)) / summary.selected
                : 0) + "%",
          }}
        />
      ))}
    </div>
  );
}

export function PlansPage() {
  const { project } = useProject();
  const [params] = useSearchParams();
  const search = useDebounced(params.get("q") || "");
  const [create, setCreate] = useState(false),
    [archived, setArchived] = useState(false);
  const data = useLoad(
    () =>
      action<{ items: Plan[]; total: number }>("list_case_plans", project.id, {
        archived,
        search,
        status: params.get("status") || null,
        sort: params.get("sort") || "created_desc",
        limit: 50,
        offset: 50 * (Number(params.get("page")) || 0),
      }),
    [
      project.id,
      archived,
      search,
      params.get("status"),
      params.get("sort"),
      params.get("page"),
    ],
  );
  const navigate = useNavigate();
  return (
    <div className="page">
      <PageHead
        eyebrow="Планирование проверок"
        title="Кейс-планы"
        description="Объедините юзер-кейсы для общей задачи — например, проверки релиза. Запускайте план повторно и сравнивайте результаты."
        actions={
          project.role !== "developer" && (
            <Button onClick={() => setCreate(true)}>
              <Plus size={16} />
              Новый план
            </Button>
          )
        }
      />
      <CatalogToolbar
        placeholder="Найти кейс-план…"
        statuses={[
          ["draft", "Черновики"],
          ["active", "Активные"],
        ]}
      />
      <div className="toolbar">
        <div className="segmented">
          <button
            className={!archived ? "active" : ""}
            onClick={() => setArchived(false)}
          >
            Активные
          </button>
          <button
            className={archived ? "active" : ""}
            onClick={() => setArchived(true)}
          >
            Архив
          </button>
        </div>
      </div>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !data.data?.items.length ? (
        <div className="panel">
          {hasCatalogFilters(params) ? (
            <NoMatches />
          ) : (
            <Empty
              title="Спланируйте проверку функционала"
              description="Например, объедините регистрацию, авторизацию и восстановление пароля в один план проверки доступа."
              action={
                project.role !== "developer" && (
                  <Button onClick={() => setCreate(true)}>
                    <Plus size={15} />
                    Создать план
                  </Button>
                )
              }
              icon={<ClipboardList size={26} />}
            />
          )}
        </div>
      ) : (
        <div className="grid-cards">
          {data.data.items.map((p) => (
            <Link className="resource-card" key={p.id} to={p.id}>
              <div className="inline spaced">
                <ClipboardList size={21} color="#8198d8" />
                <Badge status={p.status} />
              </div>
              <h3>{p.title}</h3>
              <p>{p.content.purpose || "Цель плана ещё не описана"}</p>
              <div className="card-footer">
                <small>
                  {p.content.items.length} юзер-кейсов · ревизия {p.version}
                </small>
                <ChevronRight size={16} color="#9ba9c1" />
              </div>
            </Link>
          ))}
        </div>
      )}
      <CatalogPagination total={data.data?.total || 0} />
      {create && (
        <PlanEditor
          close={() => setCreate(false)}
          saved={(p) => {
            setCreate(false);
            navigate(p.id);
          }}
        />
      )}
    </div>
  );
}

function PlanEditor({
  initial,
  close,
  saved,
}: {
  initial?: Plan;
  close: () => void;
  saved: (p: Plan) => void;
}) {
  const { project } = useProject();
  const [content, set] = useState<PlanContent>(
      initial?.content || {
        title: "",
        purpose: "",
        items: [],
        environment_id: null,
      },
    ),
    [status, setStatus] = useState(initial?.status || "draft");
  const data = useLoad(async () => {
    const [cases, envs] = await Promise.all([
      Promise.all(
        content.items.map((i) =>
          action<UseCase>("get_use_case", project.id, {
            use_case_id: i.use_case_id,
          }),
        ),
      ),
      action<{ items: Environment[] }>("list_environments", project.id),
    ]);
    return { cases, envs: envs.items };
  }, [project.id, content.items.map((i) => i.use_case_id).join()]);
  const patch = (p: Partial<PlanContent>) => set((c) => ({ ...c, ...p }));
  return (
    <Dialog
      title={initial ? "Редактирование плана" : "Новый кейс-план"}
      onClose={close}
      wide
    >
      <Form
        onSubmit={async () => {
          const p = await action<Plan>(
            initial ? "update_case_plan" : "create_case_plan",
            project.id,
            {
              ...(initial
                ? { plan_id: initial.id, expected_version: initial.version }
                : {}),
              content,
              status,
            },
          );
          saved(p);
        }}
      >
        <div className="field-row">
          <Field label="Название плана">
            <input
              autoFocus
              required
              value={content.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="Доступ и безопасность аккаунта"
            />
          </Field>
          <Field label="Состояние">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="draft">Черновик</option>
              <option value="active">Активен</option>
            </select>
          </Field>
        </div>
        <Field label="Цель проверки">
          <textarea
            value={content.purpose}
            onChange={(e) => patch({ purpose: e.target.value })}
            placeholder="Что проверяем и какой результат нужен команде"
          />
        </Field>
        <Field label="Окружение по умолчанию">
          <select
            value={content.environment_id || ""}
            onChange={(e) => patch({ environment_id: e.target.value || null })}
          >
            <option value="">Выбирать при запуске</option>
            {data.data?.envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="plan-editor-selection">
          <div className="available-cases">
            <CasePicker
              multiple
              label="Добавить юзер-кейсы в план"
              values={content.items.map((i) => ({
                id: i.use_case_id,
                label:
                  data.data?.cases.find((c) => c.id === i.use_case_id)?.title ||
                  "Загружаем название…",
              }))}
              onChange={(v) =>
                patch({
                  items: v.map(
                    (o) =>
                      content.items.find((i) => i.use_case_id === o.id) || {
                        use_case_id: o.id,
                        version_policy: "latest_published",
                        publication_id: null,
                        variant_selection: "all_enabled",
                        variant_keys: [],
                        assignee_id: null,
                      },
                  ),
                })
              }
            />
            <p className="field-hint">
              Найдите сценарии по названию или номеру. Для запуска плана они
              должны быть опубликованы.
            </p>
          </div>
          <div>
            <h3 style={{ marginBottom: 14 }}>
              Состав плана · {content.items.length}
            </h3>
            {!content.items.length ? (
              <div className="quiet-empty">
                Найдите и добавьте сценарии в поле выше
              </div>
            ) : (
              content.items.map((item, index) => (
                <PlanItemEditor
                  key={item.use_case_id}
                  item={item}
                  title={
                    data.data?.cases.find((c) => c.id === item.use_case_id)
                      ?.title || "Юзер-кейс"
                  }
                  index={index}
                  total={content.items.length}
                  change={(next) =>
                    patch({
                      items: content.items.map((i) =>
                        i.use_case_id === next.use_case_id ? next : i,
                      ),
                    })
                  }
                  remove={() =>
                    patch({
                      items: content.items.filter(
                        (i) => i.use_case_id !== item.use_case_id,
                      ),
                    })
                  }
                  move={(offset) => {
                    const next = [...content.items];
                    [next[index], next[index + offset]] = [
                      next[index + offset],
                      next[index],
                    ];
                    patch({ items: next });
                  }}
                />
              ))
            )}
          </div>
        </div>
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button type="submit">Сохранить план</Button>
        </div>
      </Form>
    </Dialog>
  );
}

function PlanItemEditor({
  item,
  title,
  index,
  total,
  change,
  remove,
  move,
}: {
  item: PlanItem;
  title: string;
  index: number;
  total: number;
  change: (v: PlanItem) => void;
  remove: () => void;
  move: (n: number) => void;
}) {
  const { project } = useProject();
  const [expand, setExpand] = useState(false);
  const optionsId = useId();
  const info = useLoad(async () => {
    const [c, history, members] = await Promise.all([
      action<UseCase>("get_use_case", project.id, {
        use_case_id: item.use_case_id,
        published_only: true,
      }),
      action<{
        publications: { id: string; number: number; revision_id: string }[];
      }>("list_use_case_history", project.id, {
        use_case_id: item.use_case_id,
      }),
      action<{ items: Member[] }>("list_project_members", project.id),
    ]);
    return { c, publications: history.publications, members: members.items };
  }, [project.id, item.use_case_id]);
  const pub = info.data?.publications.find((p) => p.id === item.publication_id);
  const revision = useLoad(
    () =>
      pub
        ? action<{ content: UseCase["content"] }>(
            "get_use_case_revision",
            project.id,
            { use_case_id: item.use_case_id, revision_id: pub.revision_id },
          )
        : Promise.resolve({ content: info.data?.c.content }),
    [pub?.id, info.data?.c],
  );
  const variants =
    item.version_policy === "fixed_publication"
      ? revision.data?.content?.variants
      : info.data?.c.content.variants;
  return (
    <div className="plan-item-editor">
      <div className="inline">
        <span className="mono muted">{index + 1}</span>
        <button
          type="button"
          className="plan-item-title grow"
          aria-expanded={expand}
          aria-controls={expand ? optionsId : undefined}
          onClick={() => setExpand((v) => !v)}
        >
          <span>{title}</span>
          <small>
            {expand ? "Свернуть настройки" : "Версия, данные и исполнитель"}
          </small>
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={index === 0}
          aria-label="Поднять кейс"
          onClick={() => move(-1)}
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={index === total - 1}
          aria-label="Опустить кейс"
          onClick={() => move(1)}
        >
          <ArrowDown size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Убрать кейс из плана"
          onClick={remove}
        >
          <X size={13} />
        </button>
      </div>
      {expand && (
        <div className="plan-item-options" id={optionsId}>
          <Field label="Версия">
            <select
              value={item.version_policy}
              onChange={(e) =>
                change({
                  ...item,
                  version_policy: e.target.value as PlanItem["version_policy"],
                  publication_id:
                    e.target.value === "fixed_publication"
                      ? info.data?.publications[0]?.id || null
                      : null,
                  variant_keys: [],
                  variant_selection: "all_enabled",
                })
              }
            >
              <option value="latest_published">
                Последняя опубликованная на момент запуска
              </option>
              <option value="fixed_publication">Закреплённая версия</option>
            </select>
          </Field>
          {item.version_policy === "fixed_publication" && (
            <Field label="Публикация">
              <select
                value={item.publication_id || ""}
                onChange={(e) =>
                  change({
                    ...item,
                    publication_id: e.target.value,
                    variant_selection: "all_enabled",
                    variant_keys: [],
                  })
                }
              >
                {info.data?.publications.map((p) => (
                  <option key={p.id} value={p.id}>
                    v{p.number}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Варианты данных">
            <select
              value={item.variant_selection}
              onChange={(e) =>
                change({
                  ...item,
                  variant_selection: e.target
                    .value as PlanItem["variant_selection"],
                  variant_keys: [],
                })
              }
            >
              <option value="all_enabled">Все включённые варианты</option>
              <option value="explicit">Выбранные варианты</option>
            </select>
          </Field>
          {item.variant_selection === "explicit" &&
            variants
              ?.filter((v) => v.enabled)
              .map((v) => (
                <label className="check-label" key={v.key}>
                  <input
                    type="checkbox"
                    checked={item.variant_keys.includes(v.key)}
                    onChange={(e) =>
                      change({
                        ...item,
                        variant_keys: e.target.checked
                          ? [...item.variant_keys, v.key]
                          : item.variant_keys.filter((k) => k !== v.key),
                      })
                    }
                  />
                  {v.name}
                </label>
              ))}
          {item.variant_selection === "explicit" &&
            !item.variant_keys.length && (
              <p className="field-hint" role="status">
                Выберите хотя бы один вариант для активного плана. Незавершённый
                выбор можно сохранить в черновике.
              </p>
            )}
          <Field label="Исполнитель по умолчанию">
            <select
              value={item.assignee_id || ""}
              onChange={(e) =>
                change({ ...item, assignee_id: e.target.value || null })
              }
            >
              <option value="">Не назначен</option>
              {info.data?.members
                .filter((m) => m.role !== "developer")
                .map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      )}
    </div>
  );
}

export function PlanPage() {
  const { project } = useProject(),
    { planId } = useParams(),
    navigate = useNavigate();
  const [tab, setTab] = useState("composition"),
    [archive, setArchive] = useState(false),
    [edit, setEdit] = useState(false),
    [preview, setPreview] = useState(false);
  const data = useLoad(
    () => action<Plan>("get_case_plan", project.id, { plan_id: planId }),
    [project.id, planId],
  );
  const cases = useLoad(
    async () => ({
      items: await Promise.all(
        (data.data?.content.items || []).map((i) =>
          action<UseCase>("get_use_case", project.id, {
            use_case_id: i.use_case_id,
          }),
        ),
      ),
    }),
    [project.id, data.data?.version],
  );
  const runs = useLoad(
    () =>
      action<{ items: Run[] }>("list_runs", project.id, { plan_id: planId }),
    [project.id, planId],
  );
  const history = useLoad(
    () =>
      action<{
        items: {
          id: string;
          number: number;
          created_at: string;
          content: PlanContent;
        }[];
      }>("list_case_plan_revisions", project.id, { plan_id: planId }),
    [project.id, planId, data.data?.version],
  );
  if (data.loading && !data.data) return <Loading />;
  if (data.error || !data.data)
    return <ErrorState error={data.error} retry={data.reload} />;
  const p = data.data,
    qa = project.role !== "developer";
  return (
    <div className="page">
      <Link to="../plans" className="back">
        <ArrowLeft size={14} />К планам
      </Link>
      <PageHead
        eyebrow={
          <>
            <Badge status={p.status} />
            <span>Ревизия {p.version}</span>
          </>
        }
        title={p.title}
        description={p.content.purpose}
        actions={
          qa && (
            <>
              <Button variant="secondary" onClick={() => setEdit(true)}>
                Изменить
              </Button>
              <Button
                disabled={!p.content.items.length || p.archived}
                onClick={() => setPreview(true)}
              >
                <Play size={14} />
                Запустить план
              </Button>
              <Button
                variant="ghost"
                aria-label={
                  p.archived ? "Восстановить план" : "Архивировать план"
                }
                onClick={() => setArchive(true)}
              >
                <Archive size={16} />
              </Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          {
            key: "composition",
            label: "Состав",
            count: p.content.items.length,
          },
          { key: "runs", label: "Прогоны", count: runs.data?.items.length },
          { key: "reports", label: "Отчёты" },
          { key: "history", label: "История" },
        ]}
      />
      {tab === "composition" ? (
        <div className="panel">
          {p.content.items.length ? (
            p.content.items.map((item, i) => (
              <Link
                key={item.use_case_id}
                className="list-row"
                to={`/p/${project.id}/cases/${item.use_case_id}`}
              >
                <span className="mono muted">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="grow">
                  <h3>
                    {cases.data?.items.find((c) => c.id === item.use_case_id)
                      ?.title || "Юзер-кейс"}
                  </h3>
                  <p>
                    {item.version_policy === "latest_published"
                      ? "Последняя опубликованная версия"
                      : "Закреплённая публикация"}{" "}
                    ·{" "}
                    {item.variant_selection === "all_enabled"
                      ? "Все включённые данные"
                      : item.variant_keys.length + " выбранных вариантов"}
                  </p>
                </div>
                <ChevronRight size={16} />
              </Link>
            ))
          ) : (
            <Empty
              title="Добавьте сценарии в план"
              action={
                qa && (
                  <Button onClick={() => setEdit(true)}>
                    Выбрать юзер-кейсы
                  </Button>
                )
              }
            />
          )}
        </div>
      ) : tab === "runs" ? (
        <RunList
          data={runs.data?.items || []}
          loading={runs.loading}
          error={runs.error}
          reload={runs.reload}
        />
      ) : tab === "reports" ? (
        <PlanReports runIds={runs.data?.items.map((r) => r.id) || []} />
      ) : (
        <div className="panel">
          {history.data?.items.map((r) => (
            <div className="list-row" key={r.id}>
              <span className="mono muted">r{r.number}</span>
              <div className="grow">
                <h3>{r.content.title}</h3>
                <p>
                  {quantity(r.content.items.length, [
                    "сценарий",
                    "сценария",
                    "сценариев",
                  ])}{" "}
                  · {date(r.created_at)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      {edit && (
        <PlanEditor
          initial={p}
          close={() => setEdit(false)}
          saved={() => {
            setEdit(false);
            data.reload();
          }}
        />
      )}
      {preview && <PreviewPlan plan={p} close={() => setPreview(false)} />}
      {archive && (
        <Dialog
          title={
            p.archived ? "Восстановить кейс-план?" : "Архивировать кейс-план?"
          }
          onClose={() => setArchive(false)}
        >
          <p>
            {p.archived
              ? "План вернётся в основной список."
              : "План переместится в архив. Его состав, история и прогоны сохранятся; план можно восстановить."}
          </p>
          <div className="form-footer">
            <Button variant="secondary" onClick={() => setArchive(false)}>
              Отмена
            </Button>
            <AsyncButton
              onAction={async () => {
                await action("archive_case_plan", project.id, {
                  object_id: p.id,
                  expected_version: p.version,
                  archived: !p.archived,
                });
                navigate("../plans");
              }}
            >
              {p.archived ? "Восстановить план" : "В архив"}
            </AsyncButton>
          </div>
        </Dialog>
      )}
    </div>
  );
}
function PlanReports({ runIds }: { runIds: string[] }) {
  const { project } = useProject();
  const data = useLoad(async () => {
    const list = await action<{ items: Report[] }>("list_reports", project.id);
    const full = await Promise.all(
      list.items.map((r) =>
        action<Report>("get_report", project.id, { report_id: r.id }),
      ),
    );
    return full.filter((r) =>
      r.snapshot.runs.some((run) => runIds.includes(run.id)),
    );
  }, [project.id, runIds.join(",")]);
  return data.loading ? <Loading /> : <ReportList items={data.data || []} />;
}
function PreviewPlan({ plan, close }: { plan: Plan; close: () => void }) {
  const { project } = useProject(),
    navigate = useNavigate();
  const [env, setEnv] = useState(plan.content.environment_id || ""),
    [title, setTitle] = useState(plan.title + " — проверка"),
    [build, setBuild] = useState("");
  const envs = useLoad(
    () => action<{ items: Environment[] }>("list_environments", project.id),
    [project.id],
  );
  const preview = useLoad(
    () =>
      action<{
        count: number;
        selection_hash: string;
        plan_revision_id: string;
        items: {
          use_case_id: string;
          publication_id: string;
          snapshot: RunItem["snapshot"];
        }[];
      }>("preview_case_plan", project.id, {
        plan_id: plan.id,
        environment_id: env || null,
      }),
    [project.id, plan.id, env],
  );
  return (
    <Dialog title="Состав нового прогона" onClose={close} wide>
      <Form
        onSubmit={async () => {
          if (!preview.data || preview.error)
            throw new Error("Обновите предварительный просмотр");
          const r = await action<Run>("create_run", project.id, {
            title,
            plan_id: plan.id,
            expected_plan_revision_id: preview.data.plan_revision_id,
            selection_hash: preview.data.selection_hash,
            environment_id: env || null,
            build,
          });
          close();
          navigate(`/p/${project.id}/runs/${r.id}`);
        }}
      >
        <div className="field-row">
          <Field label="Название прогона">
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
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
        </div>
        <Field label="Сборка / версия приложения">
          <input
            value={build}
            onChange={(e) => setBuild(e.target.value)}
            placeholder="v1.1.0 или commit SHA"
          />
        </Field>
        {preview.loading ? (
          <Loading />
        ) : preview.error ? (
          <ErrorState error={preview.error} retry={preview.reload} />
        ) : (
          <>
            <div className="note" style={{ marginBottom: 20 }}>
              {quantity(preview.data?.count || 0, [
                "проверка",
                "проверки",
                "проверок",
              ])}
              . Эти публикации и варианты будут закреплены в прогоне.
            </div>
            <div className="panel table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Юзер-кейс</th>
                    <th>Публикация</th>
                    <th>Вариант</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data?.items.map((item, i) => (
                    <tr key={i}>
                      <td>
                        {item.snapshot.content.title}
                        <br />
                        <small className="mono">{item.snapshot.key}</small>
                      </td>
                      <td>v{item.snapshot.publication_number}</td>
                      <td>
                        {item.snapshot.variant?.name || "Основной сценарий"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button type="submit" disabled={preview.loading || !!preview.error}>
            <Play size={14} />
            Создать прогон
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

export function RunsPage() {
  const { project } = useProject();
  const [create, setCreate] = useState(false);
  const [params, setParams] = useSearchParams();
  const search = useDebounced(params.get("q") || "");
  const data = useLoad(
    () =>
      action<{ items: Run[]; total: number }>("list_runs", project.id, {
        search,
        case_source: params.get("source") || null,
        status: params.get("status") || null,
        sort: params.get("sort") || "created_desc",
        limit: 50,
        offset: 50 * (Number(params.get("page")) || 0),
      }),
    [
      project.id,
      search,
      params.get("status"),
      params.get("source"),
      params.get("sort"),
      params.get("page"),
    ],
  );
  return (
    <div className="page">
      <PageHead
        eyebrow="История выполнения"
        title="Проверки"
        description="Все запуски проверок: кто выполнял сценарии, с какими данными и чем закончилась каждая попытка."
        actions={
          project.role !== "developer" && (
            <Button onClick={() => setCreate(true)}>
              <Plus size={15} />
              Новая проверка
            </Button>
          )
        }
      />
      <CatalogToolbar
        placeholder="Найти прогон по названию или сборке…"
        statuses={[
          ["draft", "Подготовка"],
          ["running", "Выполняются"],
          ["completed", "Завершённые"],
          ["cancelled", "Отменённые"],
        ]}
      />
      {project.role !== "developer" && (
        <div className="toolbar">
          <label className="inline">
            Версии сценариев{" "}
            <select
              aria-label="Версии сценариев"
              value={params.get("source") || ""}
              onChange={(e) =>
                setParams((p) => {
                  e.target.value
                    ? p.set("source", e.target.value)
                    : p.delete("source");
                  p.delete("page");
                  return p;
                })
              }
            >
              <option value="">Все прогоны</option>
              <option value="published">Опубликованные версии</option>
              <option value="draft">Черновики</option>
            </select>
          </label>
        </div>
      )}
      <RunList
        data={data.data?.items || []}
        loading={data.loading}
        error={data.error}
        reload={data.reload}
      />
      <CatalogPagination total={data.data?.total || 0} />
      {create && <NewRunDialog close={() => setCreate(false)} />}
    </div>
  );
}
function RunList({
  data,
  loading,
  error,
  reload,
}: {
  data: Run[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}) {
  const { project } = useProject();
  const [params] = useSearchParams();
  const labels: Record<string, string> = {
    draft: "Готов к началу",
    running: "Выполняется",
    completed: "Завершён",
    cancelled: "Остановлен",
  };
  return loading && !data.length ? (
    <Loading />
  ) : error ? (
    <ErrorState error={error} retry={reload} />
  ) : !data.length ? (
    <div className="panel">
      {hasCatalogFilters(params) ? (
        <NoMatches />
      ) : (
        <Empty
          title="Начните первую проверку"
          description="Выберите юзер-кейсы или готовый кейс-план. В прогоне будет видно, что уже проверено и какие результаты получила команда."
          icon={<ClipboardList size={26} />}
        />
      )}
    </div>
  ) : (
    <div className="cw-run-list">
      {data.map((r) => {
        const finished =
          r.summary.selected -
          r.summary.counts.queued -
          r.summary.counts.running;
        return (
          <Link
            className="cw-run-row"
            key={r.id}
            to={`/p/${project.id}/runs/${r.id}`}
          >
            <div className={"cw-run-row-icon " + r.status}>
              {r.status === "completed" ? (
                <Check size={21} />
              ) : r.status === "running" ? (
                <Play size={21} />
              ) : (
                <ClipboardList size={21} />
              )}
            </div>
            <div className="cw-run-row-title">
              <h2>{r.title}</h2>
              <p>
                {r.case_source === "draft" && "Черновики · "}
                {r.environment.name || "Окружение не указано"}
                {r.build && ` · ${r.build}`}
              </p>
              <small>{date(r.created_at)}</small>
            </div>
            <div className="cw-run-row-progress">
              <strong>
                {finished} из {r.summary.selected} <span>результатов</span>
              </strong>
              <Progress summary={r.summary} />
              <div className="cw-run-count-labels">
                {r.summary.counts.passed > 0 && (
                  <span className="passed">
                    {r.summary.counts.passed} совпало
                  </span>
                )}
                {r.summary.counts.failed > 0 && (
                  <span className="failed">
                    {r.summary.counts.failed} с расхождением
                  </span>
                )}
                {(r.summary.counts.scenario_issue || 0) > 0 && (
                  <span className="scenario_issue">
                    {r.summary.counts.scenario_issue} неточностей сценария
                  </span>
                )}
                {r.summary.counts.blocked > 0 && (
                  <span className="blocked">
                    {r.summary.counts.blocked} не удалось проверить
                  </span>
                )}
                {r.summary.counts.running > 0 && (
                  <span>{r.summary.counts.running} в работе</span>
                )}
                {r.summary.counts.queued > 0 && (
                  <span>{r.summary.counts.queued} ещё не начато</span>
                )}
              </div>
            </div>
            <div className="cw-run-row-action">
              <Badge status={r.status}>{labels[r.status]}</Badge>
              <span>
                {r.status === "draft"
                  ? "Начать"
                  : r.status === "running"
                    ? "Открыть прогон"
                    : "Посмотреть результаты"}
                <ChevronRight size={14} />
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function NewRunDialog({ close }: { close: () => void }) {
  const { project } = useProject(),
    navigate = useNavigate();
  const [mode, setMode] = useState<"cases" | "plan">("cases"),
    [cases, setCases] = useState<Choice[]>([]),
    [plan, setPlan] = useState<Choice[]>([]),
    [title, setTitle] = useState(""),
    [env, setEnv] = useState(""),
    [build, setBuild] = useState(""),
    [caseSource, setCaseSource] = useState<CaseSource>("published");
  const envs = useLoad(
    () => action<{ items: Environment[] }>("list_environments", project.id),
    [project.id],
  );
  const preview = useLoad(
    () =>
      mode === "plan" && plan[0]
        ? action<{
            count: number;
            selection_hash: string;
            plan_revision_id?: string;
          }>("preview_case_plan", project.id, {
            plan_id: plan[0].id,
            environment_id: env || null,
          })
        : mode === "cases" && cases.length
          ? action<{
              count: number;
              selection_hash: string;
              plan_revision_id?: string;
            }>("preview_run", project.id, {
              use_case_ids: cases.map((c) => c.id),
              environment_id: env || null,
              case_source: caseSource,
            })
          : Promise.resolve(null),
    [
      project.id,
      mode,
      plan[0]?.id,
      env,
      caseSource,
      cases.map((c) => c.id).join(),
    ],
  );
  const count = preview.data?.count;
  return (
    <Dialog title="Новая проверка" onClose={close}>
      <Form
        onSubmit={async () => {
          if (
            mode === "cases" &&
            (!cases.length || !preview.data || preview.error)
          )
            throw new Error("Выберите юзер-кейсы и дождитесь состава прогона.");
          if (mode === "plan" && (!preview.data || preview.error))
            throw new Error("Выберите кейс-план с опубликованными сценариями.");
          const r = await action<Run>("create_run", project.id, {
            title:
              title ||
              (mode === "plan"
                ? `Проверка: ${plan[0]?.label}`
                : cases.length === 1
                  ? `Проверка: ${cases[0].label}`
                  : "Проверка выбранных сценариев"
              ).slice(0, 240),
            environment_id: env || null,
            build,
            ...(mode === "plan"
              ? {
                  plan_id: plan[0].id,
                  expected_plan_revision_id: preview.data!.plan_revision_id,
                  selection_hash: preview.data!.selection_hash,
                }
              : {
                  use_case_ids: cases.map((c) => c.id),
                  case_source: caseSource,
                  selection_hash: preview.data!.selection_hash,
                }),
          });
          close();
          navigate(`/p/${project.id}/runs/${r.id}`);
        }}
      >
        <div className="segmented cw-create-mode">
          <button
            type="button"
            className={mode === "cases" ? "active" : ""}
            onClick={() => setMode("cases")}
          >
            Выбрать юзер-кейсы
          </button>
          <button
            type="button"
            className={mode === "plan" ? "active" : ""}
            onClick={() => setMode("plan")}
          >
            Взять кейс-план
          </button>
        </div>
        {mode === "cases" && (
          <CaseSourceField
            value={caseSource}
            change={(v) => {
              setCaseSource(v);
              setCases([]);
            }}
          />
        )}
        {mode === "cases" ? (
          <CasePicker
            key={caseSource}
            publishedOnly={caseSource === "published"}
            values={cases}
            multiple
            label="Какие функции проверить?"
            onChange={setCases}
          />
        ) : (
          <SearchPicker
            label="Кейс-план"
            values={plan}
            onChange={setPlan}
            multiple={false}
            placeholder="Найти план…"
            loadOptions={async (search, offset) => {
              const r = await action<{
                items: Plan[];
                total: number;
                next_offset: number | null;
              }>("list_case_plans", project.id, { search, offset, limit: 20 });
              return {
                ...r,
                items: r.items.map((p) => ({ id: p.id, label: p.title })),
              };
            }}
          />
        )}
        {preview.loading ? (
          <Loading />
        ) : preview.error ? (
          <div className="error">{preview.error?.message}</div>
        ) : (
          !!count && (
            <div className="cw-create-explainer">
              <ListChecksIcon />
              <p>
                <strong>
                  {quantity(count, ["проверка", "проверки", "проверок"])} по
                  вариантам данных
                </strong>
                <span>
                  Шаги и данные сохранятся в этом прогоне. Начать выполнение
                  можно на следующем экране.
                </span>
              </p>
            </div>
          )
        )}
        <Field label="Название прогона">
          <input
            value={title}
            maxLength={240}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Например, проверка перед релизом…"
          />
        </Field>
        <Field label="Где проверяем?">
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="">Без отдельного окружения</option>
            {envs.data?.items.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Сборка или версия приложения — необязательно">
          <input
            value={build}
            maxLength={240}
            onChange={(e) => setBuild(e.target.value)}
            placeholder="Например, v1.2 или номер сборки…"
          />
        </Field>
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Отмена
          </Button>
          <Button
            type="submit"
            disabled={!count || preview.loading || !!preview.error}
          >
            Подготовить прогон
            <ChevronRight size={15} />
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
function ListChecksIcon() {
  return <ClipboardList size={24} />;
}

export function ReportsPage() {
  const [params] = useSearchParams();
  const search = useDebounced(params.get("q") || "");
  const { project } = useProject(),
    [create, setCreate] = useState(false);
  const data = useLoad(
    () =>
      action<{ items: Report[]; total: number }>("list_reports", project.id, {
        search,
        sort: params.get("sort") || "created_desc",
        interim: params.get("status")
          ? params.get("status") === "interim"
          : null,
        limit: 50,
        offset: 50 * (Number(params.get("page")) || 0),
      }),
    [
      project.id,
      search,
      params.get("sort"),
      params.get("page"),
      params.get("status"),
    ],
  );
  const runs = useLoad(
    () => action<{ items: Run[] }>("list_runs", project.id),
    [project.id],
  );
  return (
    <div className="page">
      <PageHead
        eyebrow="Снимки результатов"
        title="Отчёты"
        description="Соберите результаты проверок в отчёт для команды. Скачайте PDF, таблицу CSV или данные JSON."
        actions={
          project.role !== "developer" && (
            <Button onClick={() => setCreate(true)}>
              <Plus size={15} />
              Новый отчёт
            </Button>
          )
        }
      />
      <CatalogToolbar
        placeholder="Найти отчёт…"
        statuses={[
          ["interim", "Промежуточные"],
          ["final", "Итоговые"],
        ]}
      />
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : (
        <ReportList items={data.data?.items || []} />
      )}
      <CatalogPagination total={data.data?.total || 0} />
      {create && (
        <ReportDialog
          runs={runs.data?.items || []}
          close={() => {
            setCreate(false);
            data.reload();
          }}
        />
      )}
    </div>
  );
}
function ReportList({ items }: { items: Report[] }) {
  const { project } = useProject();
  const [params] = useSearchParams();
  return !items.length ? (
    <div className="panel">
      {hasCatalogFilters(params) ? (
        <NoMatches />
      ) : (
        <Empty
          title="Сохраните результаты проверки"
          description="Выберите завершённые проверки и создайте отчёт. Он сохранит результаты на этот момент, даже если позже вы повторите проверку."
          icon={<FileBarChart2 size={26} />}
        />
      )}
    </div>
  ) : (
    <div className="panel">
      {items.map((r) => (
        <Link
          className="list-row"
          key={r.id}
          to={`/p/${project.id}/reports/${r.id}`}
        >
          <div className="report-icon">
            <FileBarChart2 size={18} />
          </div>
          <div className="grow">
            <h3>{r.title}</h3>
            <p>
              {date(r.created_at)} ·{" "}
              {r.audience === "project" ? "Весь проект" : "Команда QA"}
            </p>
          </div>
          <Badge status={r.interim ? "draft" : "completed"}>
            {r.interim ? "Промежуточный" : "Итоговый"}
          </Badge>
          <ChevronRight size={16} />
        </Link>
      ))}
    </div>
  );
}
export function ReportDialog({
  runs,
  close,
}: {
  runs: Pick<Run, "id" | "title" | "status" | "summary" | "case_source">[];
  close: () => void;
}) {
  const { project } = useProject(),
    navigate = useNavigate();
  const [title, setTitle] = useState("Результаты проверки"),
    [selected, setSelected] = useState(runs.length === 1 ? [runs[0].id] : []),
    [interim, setInterim] = useState(false),
    [audience, setAudience] = useState("project");
  const hasDrafts = runs.some(
    (r) => selected.includes(r.id) && r.case_source === "draft",
  );
  return (
    <Dialog title="Создать снимок отчёта" onClose={close}>
      <Form
        onSubmit={async () => {
          const r = await action<Report>("generate_report", project.id, {
            title,
            run_ids: selected,
            interim,
            audience: hasDrafts ? "qa_team" : audience,
          });
          close();
          navigate(`/p/${project.id}/reports/${r.id}`);
        }}
      >
        <Field label="Название отчёта">
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Кому доступен">
          <select
            value={hasDrafts ? "qa_team" : audience}
            disabled={hasDrafts}
            onChange={(e) => setAudience(e.target.value)}
          >
            <option value="project">Участникам проекта</option>
            <option value="qa_team">Тестировщикам и руководителям</option>
          </select>
        </Field>
        {hasDrafts && (
          <p className="field-hint">
            В отчёте есть черновики. Его увидят только тестировщики, менеджеры и
            руководитель.
          </p>
        )}
        <label className="check-label">
          <input
            type="checkbox"
            checked={interim}
            onChange={(e) => setInterim(e.target.checked)}
          />
          Промежуточный отчёт по незавершённой работе
        </label>
        <div className="report-selection">
          {!runs.length ? (
            <small>Сначала создайте и выполните прогон.</small>
          ) : (
            runs.map((r) => (
              <label className="plan-check" key={r.id}>
                <input
                  type="checkbox"
                  disabled={
                    !interim && !["completed", "cancelled"].includes(r.status)
                  }
                  checked={selected.includes(r.id)}
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked
                        ? [...s, r.id]
                        : s.filter((id) => id !== r.id),
                    )
                  }
                />
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {statusLabels[r.status]} ·{" "}
                    {quantity(r.summary.selected, [
                      "проверка",
                      "проверки",
                      "проверок",
                    ])}
                  </small>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="form-footer">
          <Button disabled={!selected.length} type="submit">
            Создать отчёт
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
export function ReportPage() {
  const { project } = useProject(),
    { reportId } = useParams();
  const data = useLoad(
    () => action<Report>("get_report", project.id, { report_id: reportId }),
    [project.id, reportId],
  );
  if (data.loading) return <Loading />;
  if (data.error || !data.data)
    return <ErrorState error={data.error} retry={data.reload} />;
  const r = data.data;
  return (
    <div className="page report-page">
      <Link className="back" to="../reports">
        <ArrowLeft size={14} />К отчётам
      </Link>
      <PageHead
        eyebrow={
          <>
            <Badge status={r.interim ? "draft" : "completed"}>
              {r.interim ? "Промежуточный" : "Итоговый"} снимок
            </Badge>
            <span>{date(r.created_at)}</span>
          </>
        }
        title={r.title}
        description={r.snapshot.project.name}
        actions={
          <>
            {["pdf", "csv", "json"].map((format) => (
              <a
                className={
                  "button " + (format === "pdf" ? "primary" : "secondary")
                }
                key={format}
                href={`/api/projects/${project.id}/reports/${r.id}/download?format=${format}`}
                download={`report-${r.id}.${format}`}
              >
                <Download size={14} />
                {format.toUpperCase()}
              </a>
            ))}
            <DiscussionButton targetType="report" targetId={r.id} />
          </>
        }
      />
      <div className="note" style={{ marginBottom: 26 }}>
        {r.snapshot.methodology}
      </div>
      {r.snapshot.runs.map((run) => (
        <section className="section" key={run.id}>
          <div className="section-title">
            <h2>{run.title}</h2>
            <Link className="text-link" to={`/p/${project.id}/runs/${run.id}`}>
              Открыть прогон ↗
            </Link>
          </div>
          <SummaryBar summary={run.summary} />
          <ReadinessSummary run={run} />
          <div className="panel table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Юзер-кейс</th>
                  <th>Вариант</th>
                  <th>Результат</th>
                  <th>Что произошло</th>
                </tr>
              </thead>
              <tbody>
                {run.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <span className="mono muted">
                        {i.snapshot.key} · {caseVersion(i.snapshot)}
                      </span>
                      <p>{i.snapshot.content.title}</p>
                    </td>
                    <td>{i.snapshot.variant?.name || "Основной сценарий"}</td>
                    <td>
                      <Badge status={i.attempts.at(-1)!.status} />
                    </td>
                    <td>
                      <p className="report-actual">
                        {i.attempts.at(-1)!.actual_result ||
                          "Результат не записан"}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <div className="report-hash">
        <span>SHA-256 содержимого снимка</span>
        <code>{r.content_hash}</code>
      </div>
    </div>
  );
}
