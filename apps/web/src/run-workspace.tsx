import { DiscussionButton } from "./discussions";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FileBarChart2,
  Info,
  ListChecks,
  FilePenLine,
  LoaderCircle,
  Paperclip,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { action, request } from "./api";
import { useProject, useSession } from "./context";
import type { Execution, Member, Run, RunItem, Step, Summary } from "./types";
import {
  AsyncButton,
  Badge,
  Button,
  CatalogPagination,
  Dialog,
  ErrorState,
  Field,
  Form,
  Loading,
  date,
  useDebounced,
  useLoad,
  useToast,
} from "./ui";
import { caseVersion } from "./types";
import { RunReadinessPanel, ReadinessSummary } from "./run-preparation";
import { ReportDialog } from "./run-pages";

export type CheckRow = {
  id: string;
  position: number;
  use_case_id: string;
  key: string;
  title: string;
  variant_name: string | null;
  polarity: string | null;
  publication_number: number | null;
  revision_number?: number;
  case_source?: "published" | "draft";
  execution_id: string;
  status: string;
  attempt: number;
  actor_id: string | null;
  actor_name: string | null;
  assignee_id: string | null;
  source: string;
  started_at: string | null;
  finished_at: string | null;
};
type Overview = Omit<Run, "items"> & {
  progress: {
    total: number;
    finished: number;
    remaining: number;
    percent: number;
  };
  active_checks: CheckRow[];
  actions: {
    can_begin: boolean;
    can_complete: boolean;
    can_cancel: boolean;
    can_create_report: boolean;
  };
  next_action: { kind: string; check_id?: string; message: string };
};
type CheckDetails = RunItem & {
  run_id: string;
  assignee_name: string | null;
  actions: {
    can_begin: boolean;
    can_record: boolean;
    can_retry: boolean;
    can_assign: boolean;
    can_annotate: boolean;
  };
};
type Begun = { check: CheckDetails | null; run: Overview; message?: string };
type Outcome = "passed" | "failed" | "scenario_issue" | "blocked" | "skipped";
const outcomes: { key: Outcome; label: string; description: string }[] = [
  {
    key: "passed",
    label: "Всё совпало",
    description: "Результат соответствует ожиданию",
  },
  {
    key: "failed",
    label: "Ошибка приложения",
    description: "Ожидание верно, но приложение ему не соответствует",
  },
  {
    key: "scenario_issue",
    label: "Неточность сценария",
    description:
      "Ожидание неоднозначно, устарело или в шагах не хватает данных",
  },
  {
    key: "blocked",
    label: "Не удалось проверить",
    description: "Не хватило доступа, данных или рабочей среды",
  },
  {
    key: "skipped",
    label: "Пропустить",
    description: "Этот вариант сейчас проверять не нужно",
  },
];
const checkLabels: Record<string, string> = {
  queued: "Ожидает начала",
  running: "В работе",
  passed: "Совпало",
  failed: "Ошибка приложения",
  scenario_issue: "Неточность сценария",
  blocked: "Не удалось проверить",
  skipped: "Пропущено",
  cancelled: "Остановлено",
};
const runLabels: Record<string, string> = {
  draft: "Подготовка",
  running: "Выполняется",
  completed: "Завершён",
  cancelled: "Остановлен",
};
function StateIcon({ status, size = 17 }: { status: string; size?: number }) {
  const Icon =
    status === "passed"
      ? CheckCircle2
      : status === "scenario_issue"
        ? FilePenLine
        : status === "failed"
          ? XCircle
          : status === "blocked"
            ? Ban
            : status === "skipped"
              ? SkipForward
              : status === "running"
                ? LoaderCircle
                : status === "cancelled"
                  ? X
                  : Play;
  return (
    <Icon
      size={size}
      aria-hidden="true"
      className={"cw-status-icon " + status}
    />
  );
}
function RunProgress({ summary }: { summary: Summary }) {
  const finished =
    summary.selected - summary.counts.queued - summary.counts.running;
  return (
    <div className="cw-progress">
      <div className="cw-progress-caption">
        <strong>
          {finished} из {summary.selected}
        </strong>
        <span>результатов сохранено</span>
      </div>
      <div
        className="cw-progress-track"
        role="progressbar"
        aria-label="Сохранённые результаты"
        aria-valuemin={0}
        aria-valuemax={summary.selected || 1}
        aria-valuenow={finished}
      >
        {(
          [
            "passed",
            "failed",
            "scenario_issue",
            "blocked",
            "skipped",
            "cancelled",
          ] as const
        ).map((s) => (
          <span
            key={s}
            className={s}
            style={{
              width:
                (summary.selected
                  ? ((summary.counts[s] || 0) / summary.selected) * 100
                  : 0) + "%",
            }}
          />
        ))}
      </div>
      <span className="cw-remaining">
        {summary.counts.running
          ? `${summary.counts.running} в работе`
          : summary.counts.queued
            ? `${summary.counts.queued} ещё не начато`
            : "Все результаты записаны"}
      </span>
    </div>
  );
}

export function RunPage() {
  const { project } = useProject(),
    { user } = useSession(),
    { runId } = useParams(),
    toast = useToast();
  const [params, setParams] = useSearchParams();
  const [showQueue, setShowQueue] = useState(false),
    [cancel, setCancel] = useState(false),
    [complete, setComplete] = useState(false),
    [report, setReport] = useState(false),
    [cancelReason, setCancelReason] = useState("");
  const search = useDebounced(params.get("q") || "");
  const overview = useLoad(
    () => action<Overview>("get_run_overview", project.id, { run_id: runId }),
    [project.id, runId],
  );
  const queue = useLoad(
    () =>
      action<{ items: CheckRow[]; total: number; next_offset: number | null }>(
        "list_run_checks",
        project.id,
        {
          run_id: runId,
          search,
          status: params.get("filter") || "all",
          assignment: params.get("assignment") || "all",
          offset: Math.max(0, Number(params.get("page")) || 0) * 50,
          limit: 50,
        },
      ),
    [
      project.id,
      runId,
      search,
      params.get("filter"),
      params.get("assignment"),
      params.get("page"),
    ],
  );
  const selected =
    params.get("check") ||
    overview.data?.active_checks.find((c) => c.actor_id === user.id)?.id ||
    queue.data?.items[0]?.id;
  const detail = useLoad(
    () =>
      selected
        ? action<CheckDetails>("get_run_check", project.id, {
            run_item_id: selected,
          })
        : Promise.resolve(null),
    [project.id, runId, selected],
  );
  const members = useLoad(
    () => action<{ items: Member[] }>("list_project_members", project.id),
    [project.id],
  );
  const refresh = () => {
    overview.reload();
    queue.reload();
    detail.reload();
  };
  const poll = useRef(refresh);
  poll.current = refresh;
  useEffect(() => {
    if (["completed", "cancelled"].includes(overview.data?.status || ""))
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") poll.current();
    }, 5000);
    return () => clearInterval(timer);
  }, [runId, overview.data?.status]);
  function select(id: string) {
    setParams(
      (p) => {
        p.set("check", id);
        return p;
      },
      { replace: true },
    );
    setShowQueue(false);
  }
  async function begin(id?: string, retry = false) {
    const response = await action<Begun>("begin_run_check", project.id, {
      run_id: runId,
      run_item_id: id || null,
      retry,
    });
    overview.setData(response.run);
    queue.reload();
    if (response.check) {
      select(response.check.id);
      detail.setData(response.check);
    } else toast(response.message || "Доступных проверок пока нет", "error");
  }
  if (!overview.data)
    return overview.error ? (
      <ErrorState error={overview.error} retry={overview.reload} />
    ) : (
      <Loading />
    );
  const r = overview.data,
    closed = ["completed", "cancelled"].includes(r.status),
    own = r.active_checks.find((c) => c.actor_id === user.id);
  const sameDetail = detail.data?.id === selected ? detail.data : null;
  const stage = closed ? 3 : r.status === "draft" ? 1 : 2;
  return (
    <div className="cw-run-shell">
      <header className="cw-header">
        <div className="cw-title">
          <Link className="back" to="../runs">
            <ArrowLeft size={14} />К проверкам
          </Link>
          <div className="inline">
            <h1>{r.title}</h1>
            <Badge status={r.status}>{runLabels[r.status]}</Badge>
          </div>
          <div className="cw-context">
            <span>
              {r.case_source === "draft"
                ? "Проверка черновиков"
                : "Проверка публикаций"}
            </span>
            <span>{r.environment.name || "Без окружения"}</span>
            {r.build && <span>Сборка {r.build}</span>}
            <span>{date(r.created_at)}</span>
          </div>
        </div>
        <div className="cw-header-actions">
          <button
            className="icon-button"
            aria-label="Обновить результаты"
            onClick={refresh}
          >
            <RefreshCw size={17} />
          </button>
          {r.actions.can_complete && (
            <Button onClick={() => setComplete(true)}>
              <Check size={16} />
              Завершить прогон
            </Button>
          )}
          {closed && r.actions.can_create_report && (
            <Button onClick={() => setReport(true)}>
              <FileBarChart2 size={16} />
              Создать отчёт
            </Button>
          )}
          <details className="cw-more">
            <summary aria-label="Другие действия">
              <ChevronDown size={16} />
            </summary>
            <div>
              {!closed && r.actions.can_create_report && (
                <button onClick={() => setReport(true)}>
                  Промежуточный отчёт
                </button>
              )}
              {r.actions.can_cancel && (
                <button className="danger-text" onClick={() => setCancel(true)}>
                  Остановить прогон
                </button>
              )}
              <button onClick={refresh}>Обновить</button>
            </div>
          </details>
        </div>
      </header>
      <div className="cw-status-bar">
        <ol className="cw-stages" aria-label="Этапы прогона">
          {["Подготовка", "Выполнение", "Результаты"].map((v, i) => (
            <li
              key={v}
              className={
                stage === i + 1 ? "current" : stage > i + 1 ? "done" : ""
              }
              aria-current={stage === i + 1 ? "step" : undefined}
            >
              <span>{stage > i + 1 ? <Check size={12} /> : i + 1}</span>
              {v}
            </li>
          ))}
        </ol>
        <RunProgress summary={r.summary} />
        {!closed && (
          <span className="cw-live">
            <span />
            Обновляется автоматически
          </span>
        )}
      </div>
      {r.status !== "draft" && <ReadinessSummary run={r} />}
      {(overview.error || queue.error || detail.error) && (
        <div className="cw-inline-error" role="alert">
          Не удалось обновить часть данных. Введённый текст сохранён в этой
          вкладке.
          <button className="text-link" onClick={refresh}>
            Повторить
          </button>
        </div>
      )}
      {r.status === "draft" && project.role !== "developer" && (
        <RunReadinessPanel
          run={r}
          begin={() => begin(selected)}
          refresh={refresh}
        />
      )}
      {r.actions.can_complete && (
        <div className="cw-callout ready">
          <div>
            <strong>Все результаты записаны</strong>
            <p>
              Завершите прогон, чтобы зафиксировать итог и подготовить отчёт для
              команды.
            </p>
          </div>
          <AsyncButton
            variant="secondary"
            onAction={async () => setComplete(true)}
          >
            Посмотреть итог
          </AsyncButton>
        </div>
      )}
      {closed && (
        <div className="cw-final-summary">
          <strong>
            {r.status === "cancelled"
              ? "Прогон остановлен"
              : r.summary.counts.passed === r.progress.total
                ? "Все проверки совпали с ожиданием"
                : "Прогон завершён. Посмотрите результаты ниже."}
          </strong>
          <OutcomeCounts summary={r.summary} />
        </div>
      )}
      <button
        className="cw-mobile-queue button secondary"
        onClick={() => setShowQueue((v) => !v)}
        aria-expanded={showQueue}
      >
        <ListChecks size={16} />
        Состав прогона · {r.progress.total}
        <ChevronDown size={14} />
      </button>
      <div className="cw-desk">
        <aside
          className={"cw-queue " + (showQueue ? "mobile-open" : "")}
          aria-label="Очередь проверок"
        >
          <div className="cw-queue-head">
            <h2>
              Что проверить <span>{r.progress.total}</span>
            </h2>
            <div className="search-input">
              <Search size={15} />
              <input
                aria-label="Поиск проверки"
                value={params.get("q") || ""}
                onChange={(e) =>
                  setParams(
                    (p) => {
                      e.target.value
                        ? p.set("q", e.target.value)
                        : p.delete("q");
                      p.delete("page");
                      return p;
                    },
                    { replace: true },
                  )
                }
                placeholder="Название или вариант…"
              />
            </div>
            <div className="cw-queue-filters">
              <select
                aria-label="Состояние проверки"
                value={params.get("filter") || "all"}
                onChange={(e) =>
                  setParams((p) => {
                    p.set("filter", e.target.value);
                    p.delete("page");
                    return p;
                  })
                }
              >
                {[
                  ["all", "Все варианты"],
                  ["pending", "Ещё не начаты"],
                  ["running", "В работе"],
                  ["attention", "Требуют внимания"],
                  ["failed", "Ошибки приложения"],
                  ["scenario_issue", "Неточности сценария"],
                  ["blocked", "Не удалось проверить"],
                  ["passed", "Совпали"],
                  ["skipped", "Пропущены"],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                aria-label="Чьи проверки"
                value={params.get("assignment") || "all"}
                onChange={(e) =>
                  setParams((p) => {
                    p.set("assignment", e.target.value);
                    p.delete("page");
                    return p;
                  })
                }
              >
                <option value="all">Все участники</option>
                <option value="mine">Мои</option>
                <option value="unassigned">Не назначены</option>
              </select>
            </div>
          </div>
          <div className="cw-queue-items">
            {queue.loading && !queue.data ? (
              <Loading />
            ) : !queue.data?.items.length ? (
              <div className="cw-quiet">
                По этим фильтрам проверок нет.
                <button
                  className="text-link"
                  onClick={() =>
                    setParams((p) => {
                      ["q", "filter", "assignment", "page"].forEach((k) =>
                        p.delete(k),
                      );
                      return p;
                    })
                  }
                >
                  Показать все
                </button>
              </div>
            ) : (
              queue.data.items.map((c, i) => (
                <div key={c.id}>
                  {(i === 0 ||
                    queue.data!.items[i - 1].use_case_id !== c.use_case_id) && (
                    <div className="cw-case-group">
                      <small>
                        {c.key} · {caseVersion(c)}
                      </small>
                      <h3>{c.title}</h3>
                    </div>
                  )}
                  <button
                    className={
                      "cw-queue-item " + (selected === c.id ? "selected" : "")
                    }
                    onClick={() => select(c.id)}
                    aria-current={selected === c.id ? "true" : undefined}
                  >
                    <StateIcon status={c.status} />
                    <span>
                      <strong>{c.variant_name || "Основной сценарий"}</strong>
                      <small>
                        {checkLabels[c.status]}
                        {c.status === "running" && c.actor_name
                          ? ` · ${c.actor_name}`
                          : ""}
                      </small>
                    </span>
                    {c.attempt > 1 && (
                      <span className="cw-attempt">#{c.attempt}</span>
                    )}
                  </button>
                </div>
              ))
            )}
          </div>
          <CatalogPagination total={queue.data?.total || 0} />
        </aside>
        {sameDetail ? (
          <CheckPanel
            key={sameDetail.id + sameDetail.attempts.at(-1)?.id}
            check={sameDetail}
            run={r}
            members={members.data?.items || []}
            begin={begin}
            refresh={refresh}
            resume={own ? () => select(own.id) : undefined}
            onFinished={(response) => {
              overview.setData(response.run);
              queue.reload();
              const next = response.run.next_action.check_id;
              if (next && next !== selected) select(next);
              else detail.reload();
            }}
          />
        ) : (
          <div className="cw-check-panel">
            <Loading />
          </div>
        )}
      </div>
      {cancel && (
        <Dialog title="Остановить прогон?" onClose={() => setCancel(false)}>
          <p className="dialog-description">
            Сохранённые результаты останутся в истории. Остальные{" "}
            {r.progress.remaining} проверок получат статус «Остановлено».
            Продолжить этот прогон после остановки не получится.
          </p>
          <Form
            onSubmit={async () => {
              await action("cancel_run", project.id, {
                run_id: r.id,
                expected_version: r.version,
                reason: cancelReason,
              });
              setCancel(false);
              refresh();
            }}
          >
            <Field label="Почему останавливаем?">
              <textarea
                required
                maxLength={240}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Например, сборка больше недоступна…"
              />
            </Field>
            <div className="form-footer">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCancel(false)}
              >
                Продолжить проверку
              </Button>
              <Button variant="danger" type="submit">
                Остановить прогон
              </Button>
            </div>
          </Form>
        </Dialog>
      )}
      {complete && (
        <Dialog title="Завершить прогон?" onClose={() => setComplete(false)}>
          <p className="dialog-description">
            Записано {r.progress.finished} из {r.progress.total} результатов.
            После завершения можно будет создать отчёт. Для повторной проверки
            понадобится новый прогон.
          </p>
          <OutcomeCounts summary={r.summary} />
          <div className="form-footer">
            <Button variant="secondary" onClick={() => setComplete(false)}>
              Вернуться к результатам
            </Button>
            <AsyncButton
              onAction={async () => {
                await action("complete_run", project.id, {
                  run_id: r.id,
                  expected_version: r.version,
                });
                setComplete(false);
                refresh();
                toast("Прогон завершён. Теперь можно создать отчёт.");
              }}
            >
              Завершить прогон
            </AsyncButton>
          </div>
        </Dialog>
      )}
      {report && <ReportDialog runs={[r]} close={() => setReport(false)} />}
    </div>
  );
}
function OutcomeCounts({ summary }: { summary: Summary }) {
  return (
    <div className="cw-counts">
      {(
        [
          "passed",
          "failed",
          "scenario_issue",
          "blocked",
          "skipped",
          "cancelled",
        ] as const
      )
        .filter((s) => summary.counts[s])
        .map((s) => (
          <span key={s} className={s}>
            <StateIcon status={s} size={15} />
            {summary.counts[s]} · {checkLabels[s]}
          </span>
        ))}
    </div>
  );
}

function CheckPanel({
  check,
  run,
  members,
  begin,
  refresh,
  resume,
  onFinished,
}: {
  check: CheckDetails;
  run: Overview;
  members: Member[];
  begin: (id?: string, retry?: boolean) => Promise<void>;
  refresh: () => void;
  resume?: () => void;
  onFinished: (v: { run: Overview }) => void;
}) {
  const { project } = useProject(),
    toast = useToast();
  const [attempt, setAttempt] = useState<string>(""),
    [result, setResult] = useState(false),
    [annotation, setAnnotation] = useState(false),
    [note, setNote] = useState("");
  const [discussionParams] = useSearchParams();
  useEffect(() => {
    setAttempt(discussionParams.get("execution") || "");
  }, [discussionParams.get("execution"), check.id]);
  const latest = check.attempts.at(-1)!;
  const execution = check.attempts.find((e) => e.id === attempt) || latest;
  const past = execution.id !== latest.id,
    terminal = !["queued", "running"].includes(execution.status);
  const override = check.snapshot.variant?.steps_override;
  const steps = override ?? check.snapshot.content.steps;
  const recorded = steps.filter((s) => execution.steps[s.key]).length;
  const canRecord = check.actions.can_record && !past;
  return (
    <section className="cw-check-panel">
      <header className="cw-check-head">
        <div>
          <div className="cw-check-meta">
            <Link to={`/p/${project.id}/cases/${check.use_case_id}`}>
              {check.snapshot.key}
            </Link>
            <span>{caseVersion(check.snapshot)}</span>
          </div>
          <h2>{check.snapshot.content.title}</h2>
          <p className="cw-variant-name">
            {check.snapshot.variant?.name || "Основной сценарий"}
          </p>
        </div>
        <div className="cw-check-actions">
          <div className={"cw-check-state " + execution.status}>
            <StateIcon status={execution.status} />
            <span>
              {checkLabels[execution.status]}
              {execution.actor_name && (
                <small>
                  {execution.source === "agent" ? "ИИ-агент" : "Вручную"} ·{" "}
                  {execution.actor_name}
                </small>
              )}
            </span>
          </div>
          <DiscussionButton targetType="execution" targetId={execution.id} />
        </div>
      </header>
      <div className="cw-check-scroll">
        {check.attempts.length > 1 && (
          <Field label="Попытка">
            <select
              value={execution.id}
              onChange={(e) => setAttempt(e.target.value)}
            >
              {[...check.attempts].reverse().map((e) => (
                <option key={e.id} value={e.id}>
                  Попытка {e.attempt} · {checkLabels[e.status]}
                  {e.id === latest.id ? " · текущая" : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        {terminal && (
          <section className={"cw-saved-result " + execution.status}>
            <div className="inline spaced">
              <h3>{checkLabels[execution.status]}</h3>
              <span className="cw-saved-stamp">
                <Check size={14} />
                Сохранено
              </span>
            </div>
            <p>{execution.actual_result}</p>
            <small>
              {date(execution.finished_at)}
              {execution.actor_name && ` · ${execution.actor_name}`}
            </small>
            {execution.external_issue_url && (
              <a
                className="text-link"
                href={execution.external_issue_url}
                target="_blank"
                rel="noreferrer"
              >
                Открыть задачу об ошибке ↗
              </a>
            )}
          </section>
        )}
        <div className="cw-check-data">
          <section>
            <h3>Данные для этого варианта</h3>
            {check.snapshot.variant &&
            Object.keys(check.snapshot.variant.inputs).length ? (
              <dl className="cw-input-values">
                {Object.entries(check.snapshot.variant.inputs).map(
                  ([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>
                        <code>
                          {value === "" ? "Пустая строка" : String(value)}
                        </code>
                        <button
                          className="icon-button"
                          aria-label={`Скопировать ${key}`}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                value === null ? "null" : String(value),
                              );
                              toast("Значение скопировано");
                            } catch {
                              toast("Не удалось скопировать значение", "error");
                            }
                          }}
                        >
                          <Copy size={13} />
                        </button>
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            ) : (
              <p className="muted">Отдельные входные данные не требуются.</p>
            )}
          </section>
          <section className="cw-expected">
            <h3>Что должно произойти</h3>
            <div className="prose">
              <Markdown>
                {check.snapshot.variant?.expected ||
                  "Ожидаемый результат описан в шагах ниже."}
              </Markdown>
            </div>
            {check.snapshot.variant?.polarity === "negative" && (
              <p className="cw-negative-help">
                <Info size={14} />
                Если приложение отклонило данные именно так, как описано,
                проверка считается успешной.
              </p>
            )}
          </section>
        </div>
        {(check.snapshot.content.preconditions ||
          check.snapshot.accounts.length ||
          check.snapshot.content.cleanup ||
          check.snapshot.variant?.notes ||
          check.snapshot.content.specifications.length > 0) && (
          <details className="cw-preparation">
            <summary>
              Подготовка и дополнительная информация
              <ChevronDown size={14} />
            </summary>
            {check.snapshot.content.preconditions && (
              <section>
                <h3>Перед началом</h3>
                <div className="prose">
                  <Markdown>{check.snapshot.content.preconditions}</Markdown>
                </div>
              </section>
            )}
            {check.snapshot.variant?.notes && (
              <section>
                <h3>Примечание к данным</h3>
                <Markdown>{check.snapshot.variant.notes}</Markdown>
              </section>
            )}
            {check.snapshot.accounts.length > 0 && (
              <section>
                <h3>Тестовые аккаунты</h3>
                {check.snapshot.accounts.map((a) => (
                  <Link
                    key={a.id}
                    className="cw-account"
                    to={`/p/${project.id}/accounts?open=${a.id}`}
                  >
                    <UserRound size={15} />
                    <span>
                      {a.name}
                      <small>{a.login}</small>
                    </span>
                    <ArrowRight size={14} />
                  </Link>
                ))}
              </section>
            )}
            {check.snapshot.content.cleanup && (
              <section>
                <h3>После проверки</h3>
                <Markdown>{check.snapshot.content.cleanup}</Markdown>
              </section>
            )}
          </details>
        )}
        <section className="cw-steps">
          <div className="cw-section-heading">
            <h3>Шаги проверки</h3>
            <span>
              {terminal && !recorded
                ? "Без отдельных отметок по шагам"
                : `${recorded} из ${steps.length} отмечено`}
            </span>
          </div>
          {steps.map((step, i) => (
            <StepCard
              key={execution.id + step.key}
              step={step}
              index={i}
              execution={execution}
              editable={canRecord}
              refresh={refresh}
            />
          ))}
        </section>
        {(execution.attachments?.length || 0) > 0 && (
          <section className="cw-proof-list">
            <h3>Файлы проверки</h3>
            {execution.attachments?.map((a) => (
              <a
                key={a.id}
                href={`/api/projects/${project.id}/attachments/${a.id}`}
              >
                <Paperclip size={15} />
                <span>{a.filename}</span>
                <small>{Math.max(1, Math.round(a.size / 1024))} КБ</small>
                <Download size={14} />
              </a>
            ))}
          </section>
        )}
        {execution.annotations?.map((a) => (
          <div key={a.id} className="cw-annotation">
            <strong>Дополнение к результату</strong>
            <p>{a.body}</p>
            <small>{date(a.created_at)}</small>
          </div>
        ))}
        {terminal && (
          <div className="cw-result-actions">
            {!past && check.actions.can_retry && (
              <AsyncButton
                variant="secondary"
                onAction={() => begin(check.id, true)}
              >
                <RotateCcw size={14} />
                Повторить эту проверку
              </AsyncButton>
            )}
            {check.actions.can_annotate && (
              <Button variant="ghost" onClick={() => setAnnotation(true)}>
                Добавить пояснение
              </Button>
            )}
          </div>
        )}
        <details className="cw-preparation cw-assignment">
          <summary>
            Участники и сведения
            <ChevronDown size={14} />
          </summary>
          {run.environment.base_url && (
            <p>
              Приложение:{" "}
              <a
                className="text-link"
                href={run.environment.base_url}
                target="_blank"
                rel="noreferrer"
              >
                {run.environment.base_url} ↗
              </a>
            </p>
          )}
          <Field label="Кому назначена проверка">
            <select
              disabled={!check.actions.can_assign}
              value={check.assignee_id || ""}
              onChange={async (e) => {
                try {
                  await action("assign_run_item", project.id, {
                    run_item_id: check.id,
                    assignee_id: e.target.value || null,
                  });
                  refresh();
                } catch (e) {
                  toast((e as Error).message, "error");
                }
              }}
            >
              <option value="">Любому тестировщику</option>
              {members
                .filter((m) => m.role !== "developer")
                .map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </Field>
          <p className="field-hint">
            Версия сценария и данные закреплены при создании прогона. Изменения
            черновика и новые публикации их не меняют.
          </p>
        </details>
      </div>
      <footer className="cw-check-footer">
        {past ? (
          <>
            <span>Вы просматриваете прошлую попытку.</span>
            <Button variant="secondary" onClick={() => setAttempt("")}>
              К текущей попытке
            </Button>
          </>
        ) : canRecord ? (
          <>
            <div>
              <strong>Проверка в работе</strong>
              <small>Выполните шаги и запишите, что произошло.</small>
            </div>
            <Button onClick={() => setResult(true)}>
              Записать результат
              <ArrowRight size={15} />
            </Button>
          </>
        ) : check.actions.can_begin &&
          execution.status === "queued" &&
          run.status !== "draft" ? (
          <>
            <span>Этот вариант ещё не проверяли.</span>
            <AsyncButton onAction={() => begin(check.id)}>
              <Play size={15} />
              Начать проверку
            </AsyncButton>
          </>
        ) : execution.status === "running" ? (
          <span>
            <LoaderCircle size={15} />
            Сейчас проверяет {execution.source === "agent" ? "ИИ-агент " : ""}
            {execution.actor_name || "участник"}. Результаты обновятся
            автоматически.
          </span>
        ) : resume && !terminal ? (
          <>
            <span>У вас уже есть проверка в работе.</span>
            <Button variant="secondary" onClick={resume}>
              Продолжить её
            </Button>
          </>
        ) : terminal && run.next_action.kind === "begin_check" ? (
          <>
            <span>Результат сохранён в истории.</span>
            <AsyncButton variant="secondary" onAction={() => begin()}>
              Взять следующую
              <ArrowRight size={15} />
            </AsyncButton>
          </>
        ) : (
          <span>
            {run.status === "draft"
              ? "Нажмите «Начать проверку» вверху, когда будете готовы."
              : !terminal && check.assignee_name
                ? `Ожидает участника: ${check.assignee_name}`
                : "Результаты сохранены и доступны для отчёта."}
          </span>
        )}
      </footer>
      {result && canRecord && (
        <OutcomeDialog
          execution={execution}
          steps={steps}
          check={check}
          remaining={run.progress.remaining}
          close={() => setResult(false)}
          refresh={refresh}
          saved={(v) => {
            setResult(false);
            onFinished(v);
          }}
        />
      )}
      {annotation && (
        <Dialog
          title="Дополнить результат"
          onClose={() => setAnnotation(false)}
        >
          <Form
            onSubmit={async () => {
              await action("add_execution_annotation", project.id, {
                execution_id: execution.id,
                body: note,
              });
              setAnnotation(false);
              setNote("");
              refresh();
            }}
          >
            <Field label="Что нужно уточнить?">
              <textarea
                required
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Пояснение добавится отдельной записью…"
              />
            </Field>
            <div className="form-footer">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setAnnotation(false)}
              >
                Отмена
              </Button>
              <Button type="submit">Добавить пояснение</Button>
            </div>
          </Form>
        </Dialog>
      )}
    </section>
  );
}
function StepCard({
  step,
  index,
  execution,
  editable,
  refresh,
}: {
  step: Step;
  index: number;
  execution: Execution;
  editable: boolean;
  refresh: () => void;
}) {
  const { project } = useProject(),
    toast = useToast(),
    existing = execution.steps[step.key];
  const [note, setNote] = useState(existing?.actual_result || ""),
    [showNote, setShowNote] = useState(false),
    [saving, setSaving] = useState(false);
  async function mark(status: Outcome) {
    setSaving(true);
    try {
      await action("record_step_result", project.id, {
        execution_id: execution.id,
        step_key: step.key,
        status,
        actual_result: note,
      });
      if (status !== "passed") setShowNote(true);
      refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }
  return (
    <article className={"cw-step " + (existing?.status || "")}>
      <span className="cw-step-number">
        {existing ? (
          <StateIcon status={existing.status} size={18} />
        ) : (
          index + 1
        )}
      </span>
      <div className="cw-step-content">
        <div className="prose cw-step-action">
          <Markdown>{step.action}</Markdown>
        </div>
        <div className="cw-step-expected">
          <span>Ожидаем</span>
          <div className="prose">
            <Markdown>{step.expected}</Markdown>
          </div>
        </div>
        {editable ? (
          <>
            <div className="cw-step-buttons">
              {(
                [
                  ["passed", "Совпало"],
                  ["failed", "Ошибка приложения"],
                  ["scenario_issue", "Уточнить сценарий"],
                  ["blocked", "Не могу проверить"],
                ] as [Outcome, string][]
              ).map(([status, label]) => (
                <button
                  key={status}
                  className={
                    "cw-step-verdict " +
                    status +
                    " " +
                    (existing?.status === status ? "selected" : "")
                  }
                  type="button"
                  disabled={saving}
                  aria-pressed={existing?.status === status}
                  onClick={() => mark(status)}
                >
                  <StateIcon status={status} size={14} />
                  {label}
                </button>
              ))}
              {existing && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setShowNote((v) => !v)}
                >
                  {note ? "Изменить пояснение" : "Пояснить"}
                </button>
              )}
              {saving && (
                <span role="status" className="cw-saving">
                  Сохраняем…
                </span>
              )}
            </div>
            {showNote && existing && (
              <Form
                className="cw-step-note"
                onSubmit={async () => {
                  await mark(existing.status as Outcome);
                  setShowNote(false);
                }}
              >
                <Field label="Наблюдение по шагу">
                  <textarea
                    value={note}
                    maxLength={10000}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Что увидели при выполнении этого шага…"
                    rows={2}
                  />
                </Field>
                <Button type="submit" variant="secondary">
                  Сохранить пояснение
                </Button>
              </Form>
            )}
          </>
        ) : (
          existing && (
            <div className={"cw-step-observation " + existing.status}>
              <strong>{checkLabels[existing.status]}</strong>
              {existing.actual_result && <p>{existing.actual_result}</p>}
            </div>
          )
        )}
      </div>
    </article>
  );
}

function OutcomeDialog({
  execution,
  steps,
  check,
  remaining,
  close,
  refresh,
  saved,
}: {
  execution: Execution;
  steps: Step[];
  check: CheckDetails;
  remaining: number;
  close: () => void;
  refresh: () => void;
  saved: (v: { run: Overview }) => void;
}) {
  const { project } = useProject(),
    { user } = useSession(),
    toast = useToast();
  const draftKey = `ucaselab:result:${user.id}:${project.id}:${execution.id}`;
  const [initial] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(draftKey) || "{}");
    } catch {
      return {};
    }
  });
  const [status, setStatus] = useState<Outcome | null>(initial.status || null),
    [actual, setActual] = useState(initial.actual || ""),
    [issue, setIssue] = useState(initial.issue || ""),
    [uploading, setUploading] = useState(false),
    [files, setFiles] = useState<{ id: string; filename: string }[]>(
      execution.attachments || [],
    );
  const allPassed =
    steps.length > 0 &&
    steps.every(
      (s) =>
        s.action.trim() &&
        s.expected.trim() &&
        execution.steps[s.key]?.status === "passed",
    );
  useEffect(() => {
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({ status, actual, issue }),
      );
    } catch {}
  }, [draftKey, status, actual, issue]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (actual || status) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [actual, status]);
  return (
    <Dialog title="Чем закончилась проверка?" onClose={close} wide>
      <p className="cw-outcome-context">
        {check.snapshot.content.title} ·{" "}
        {check.snapshot.variant?.name || "Основной сценарий"}
      </p>
      <Form
        onSubmit={async () => {
          if (!status) throw new Error("Выберите результат проверки.");
          if (uploading) throw new Error("Дождитесь загрузки файла.");
          if (status === "passed" && !allPassed)
            throw new Error(
              "Сначала отметьте каждый шаг как совпавший с ожиданием.",
            );
          const result = await action<{ run: Overview }>(
            "finish_run_check",
            project.id,
            {
              execution_id: execution.id,
              status,
              actual_result: actual,
              external_issue_url: issue,
            },
          );
          sessionStorage.removeItem(draftKey);
          toast("Результат сохранён");
          saved(result);
        }}
      >
        <div
          className="cw-outcomes"
          role="group"
          aria-label="Результат проверки"
        >
          {outcomes.map((o) => (
            <label
              key={o.key}
              className={
                "cw-outcome " +
                o.key +
                " " +
                (status === o.key ? "selected" : "") +
                (o.key === "passed" && !allPassed ? " unavailable" : "")
              }
            >
              <input
                type="radio"
                name="check-outcome"
                value={o.key}
                required
                checked={status === o.key}
                disabled={o.key === "passed" && !allPassed}
                onChange={() => setStatus(o.key)}
              />
              <StateIcon status={o.key} size={20} />
              <span>
                <strong>{o.label}</strong>
                <small>{o.description}</small>
              </span>
            </label>
          ))}
        </div>
        {!allPassed && (
          <p className="field-hint cw-outcome-hint">
            «Всё совпало» станет доступно, когда каждый шаг будет отмечен как
            совпавший с ожиданием. Если проверить не удалось, выберите
            соответствующий результат и укажите причину.
          </p>
        )}
        <Field
          label={
            status === "passed"
              ? "Что подтвердили при проверке?"
              : status === "scenario_issue"
                ? "Что нужно уточнить в сценарии и что вы наблюдали?"
                : status === "failed"
                  ? "Что произошло и чем отличается от подтверждённого ожидания?"
                  : status === "blocked"
                    ? "Что помешало выполнить проверку?"
                    : status === "skipped"
                      ? "Почему пропускаем этот вариант?"
                      : "Опишите, что произошло"
          }
        >
          <textarea
            required
            value={actual}
            maxLength={30000}
            onChange={(e) => setActual(e.target.value)}
            rows={4}
            placeholder={
              status === "passed"
                ? "Например, письмо пришло, ссылка подтвердила почту, открылся список проектов…"
                : status === "scenario_issue"
                  ? "Например, сценарий требует выбрать тип, но он уже выбран по умолчанию. Укажите шаг и какое ожидание требует уточнения…"
                  : status === "blocked"
                    ? "Например, тестовый сервер не отвечает; шаги выполнить не удалось…"
                    : "Запишите наблюдение или причину, чтобы команда поняла результат…"
            }
          />
        </Field>
        <details className="cw-extra-result">
          <summary>
            Файлы и ссылка на задачу <span>необязательно</span>
          </summary>
          <div className="cw-file-upload">
            <label
              className={"button secondary " + (uploading ? "disabled" : "")}
            >
              <Paperclip size={15} />
              {uploading ? "Загружаем…" : "Добавить файл"}
              <input
                type="file"
                className="sr-only"
                aria-label="Добавить файл к проверке"
                disabled={uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    const form = new FormData();
                    form.append("file", file);
                    const r = await request<{ id: string; filename: string }>(
                      `/projects/${project.id}/attachments/upload?execution_id=${execution.id}`,
                      { method: "POST", body: form },
                    );
                    setFiles((v) => [...v, r]);
                    refresh();
                  } catch (e) {
                    toast((e as Error).message, "error");
                  } finally {
                    setUploading(false);
                    e.target.value = "";
                  }
                }}
              />
            </label>
            <small>Скриншот, видео или журнал — до 20 МБ.</small>
          </div>
          {files.map((f) => (
            <div key={f.id || f.filename} className="cw-file-name">
              <Paperclip size={13} />
              {f.filename}
            </div>
          ))}
          <Field label="Ссылка на задачу об ошибке">
            <input
              type="url"
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              placeholder="https://tracker.example/issue/123"
            />
          </Field>
        </details>
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={close}>
            Вернуться к шагам
          </Button>
          <Button type="submit" disabled={uploading}>
            {remaining > 1
              ? "Сохранить и перейти дальше"
              : "Сохранить результат"}
            <ArrowRight size={15} />
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
