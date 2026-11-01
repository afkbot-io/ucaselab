import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { action } from "./api";
import { useProject, useSession } from "./context";
import {
  AsyncButton,
  Button,
  Empty,
  ErrorState,
  Field,
  Loading,
  date,
  useLoad,
} from "./ui";

type Item = {
  id: string;
  project_id: string;
  actor_id: string;
  actor_name: string;
  created_at: string;
  event_type: string;
  entity_type: string;
  read: boolean;
  path: string;
};
type Author = { id: string; name: string };
type Feed = {
  actors: Author[];
  items: Item[];
  unread_count: number;
  next_cursor: string | null;
};
const entities: Record<string, string> = {
  use_case: "Юзер-кейсы",
  thread: "Обсуждения",
  proposal: "Предложения",
  specification: "Спецификации",
  execution: "Проверки",
  run: "Прогоны",
  report: "Отчёты",
  plan: "Кейс-планы",
};
const actions: Record<string, string> = {
  archived: "Архивирование",
  created: "Создание",
  draft_saved: "Сохранение черновика",
  published: "Публикация",
  moved: "Перемещение",
  revision_restored: "Восстановление версии",
  submitted: "Отправка",
  prepared: "Подготовка",
  accepted: "Принятие",
  rejected: "Отклонение",
  withdrawn: "Отзыв",
  updated: "Изменение",
  deleted: "Удаление",
  restored: "Восстановление",
  finished: "Результат проверки",
  completed: "Завершение",
  cancelled: "Отмена",
  generated: "Создание отчёта",
  replied: "Ответ",
  edited: "Правка сообщения",
  moderated: "Модерация",
  resolved: "Решено",
  reopened: "Возобновление",
};
const eventActions: Record<string, string[]> = {
  use_case: [
    "created",
    "draft_saved",
    "published",
    "moved",
    "revision_restored",
    "archived",
    "restored",
  ],
  thread: [
    "created",
    "replied",
    "edited",
    "deleted",
    "moderated",
    "resolved",
    "reopened",
  ],
  proposal: [
    "submitted",
    "updated",
    "prepared",
    "accepted",
    "rejected",
    "withdrawn",
  ],
  specification: [
    "created",
    "updated",
    "moved",
    "deleted",
    "restored",
    "archived",
  ],
  execution: ["finished"],
  run: ["created", "completed", "cancelled"],
  report: ["generated"],
  plan: ["created", "updated", "archived", "restored"],
};
function localDateToISO(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
const emptyFeed: Feed = {
  actors: [],
  items: [],
  unread_count: 0,
  next_cursor: null,
};

export function ActivityPanel({ close }: { close: () => void }) {
  const { project } = useProject(),
    { projects } = useSession(),
    navigate = useNavigate();
  const [projectFilter, setProject] = useState(project.id),
    [entity, setEntity] = useState(""),
    [event, setEvent] = useState(""),
    [actor, setActor] = useState<Author | null>(null),
    [since, setSince] = useState(""),
    [until, setUntil] = useState(""),
    [read, setRead] = useState("");
  const [more, setMore] = useState<Item[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const pid = projectFilter || project.id;
  const sinceISO = localDateToISO(since),
    untilISO = localDateToISO(until);
  const dateError =
    (since && !sinceISO) || (until && !untilISO)
      ? "Укажите корректные дату и время."
      : sinceISO && untilISO && new Date(sinceISO).getTime() > new Date(untilISO).getTime()
        ? "Начало периода должно быть не позже окончания."
        : "";
  const activeCount = [
    projectFilter !== project.id, entity, event, actor, since, until, read,
  ].filter(Boolean).length;
  const resetFilters = () => {
    setProject(project.id);
    setEntity("");
    setEvent("");
    setActor(null);
    setSince("");
    setUntil("");
    setRead("");
  };
  const filters = {
    all_projects: !projectFilter,
    entity_type: entity || null,
    event_type: event || null,
    actor_id: actor?.id || null,
    since: sinceISO,
    until: untilISO,
    unread: read ? read === "unread" : null,
  };
  const queryKey = JSON.stringify([pid, filters, since, until]);
  const activeQuery = useRef(queryKey);
  const generation = useRef(0);
  if (activeQuery.current !== queryKey) {
    activeQuery.current = queryKey;
    generation.current++;
  }
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const data = useLoad(
    () => dateError
      ? Promise.resolve(emptyFeed)
      : action<Feed>("list_activity", pid, filters),
    [pid, projectFilter, entity, event, actor, since, until, read],
  );
  useEffect(() => {
    setMore([]);
    setCursor(data.data?.next_cursor ?? null);
  }, [data.data]);
  const items = [...(data.data?.items || []), ...more];
  const refresh = () => {
    generation.current++;
    setMore([]);
    data.reload();
  };
  return (
    <div className="activity-content">
      <p className="muted">
        Ваши действия уже прочитаны. Чужие — после открытия события или отметки вручную.
      </p>
      <section className="activity-filter-group" aria-label="Фильтры истории">
        <div className="activity-filter-heading">
          <h3>Фильтры истории</h3>
          <Button variant="ghost" disabled={!activeCount} onClick={resetFilters}>
            Сбросить фильтры{activeCount ? ` (${activeCount})` : ""}
          </Button>
        </div>
        <div className="activity-filters">
          <Field label="Проект истории">
            <div className="activity-select">
            <select
              value={projectFilter}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">Все доступные проекты</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
            </div>
          </Field>
          <Field label="Тип объекта">
            <div className="activity-select">
            <select
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value);
                setEvent("");
              }}
            >
              <option value="">Все объекты</option>
              {Object.entries(entities).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
            </div>
          </Field>
          <Field label="Событие">
            <div className="activity-select">
            <select value={event} onChange={(e) => setEvent(e.target.value)}>
              <option value="">Все события</option>
              {Object.keys(entities)
                .filter((k) => !entity || k === entity)
                .flatMap((kind) =>
                  eventActions[kind].map((key) => (
                    <option
                      key={kind + key}
                      value={`${kind === "thread" ? "discussion" : kind}.${key}`}
                    >
                      {entities[kind]} · {actions[key]}
                    </option>
                  )),
                )}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
            </div>
          </Field>
          <Field label="Автор события">
            <div className="activity-select">
            <select
              value={actor?.id || ""}
              onChange={(e) => setActor(
                data.data?.actors.find((author) => author.id === e.target.value) ?? null,
              )}
            >
              <option value="">Все авторы</option>
              {actor && !data.data?.actors.some((author) => author.id === actor.id) && (
                <option value={actor.id}>{actor.name}</option>
              )}
              {data.data?.actors.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
            </div>
          </Field>
          <Field label="Состояние чтения">
            <div className="activity-select">
            <select value={read} onChange={(e) => setRead(e.target.value)}>
              <option value="">Все</option>
              <option value="unread">Непрочитанные</option>
              <option value="read">Прочитанные</option>
            </select>
            <ChevronDown size={16} aria-hidden="true" />
            </div>
          </Field>
        </div>
        <details className="activity-period">
          <summary>Период{since || until ? " · задан" : " · за всё время"}</summary>
          <div className="activity-filters">
          <Field label="С даты">
            <input
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </Field>
          <Field label="До даты">
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </Field>
          </div>
        </details>
      </section>
      {dateError && <p role="alert" className="error-text">{dateError}</p>}
      <div className="inline spaced activity-toolbar">
        <Button variant="ghost" onClick={refresh}>
          Обновить
        </Button>
        <AsyncButton
          variant="secondary"
          disabled={!items.some((i) => !i.read) || data.loading || !!data.error || !!dateError}
          onAction={async () => {
            for (let start = 0; start < items.length; start += 100)
              await action("mark_activity_read", pid, {
                event_ids: items.slice(start, start + 100).map((i) => i.id),
                all_projects: !projectFilter,
              });
            refresh();
          }}
        >
          Прочитать показанные
        </AsyncButton>
      </div>
      {dateError ? null : data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState error={data.error} retry={refresh} />
      ) : !items.length ? (
        <Empty
          title={activeCount ? "По фильтрам ничего не найдено" : "Событий пока нет"}
          description={activeCount ? "Измените условия или сбросьте фильтры, чтобы увидеть историю." : "Здесь появятся изменения доступных вам объектов."}
        />
      ) : (
        <div className="activity-list">
          {items.map((item) => (
            <article
              className={
                "list-row notification-row " + (!item.read ? "unread" : "")
              }
              key={item.id}
            >
              <div className="grow">
                <h3>
                  {entities[item.entity_type]} ·{" "}
                  {actions[item.event_type.split(".")[1]] || item.event_type}
                </h3>
                <p>
                  {item.actor_name} · {date(item.created_at)}
                  {!projectFilter &&
                    ` · ${projects.find((p) => p.id === item.project_id)?.name || "Проект"}`}
                </p>
                <small>{item.read ? "Прочитано" : "Не прочитано"}</small>
              </div>
              <AsyncButton
                variant="ghost"
                onAction={async () => {
                  await action("mark_activity_read", pid, {
                    event_ids: [item.id],
                    all_projects: !projectFilter,
                  });
                  close();
                  navigate(item.path);
                }}
              >
                Открыть
              </AsyncButton>
            </article>
          ))}
        </div>
      )}
      {cursor && !data.loading && !data.error && !dateError && (
        <AsyncButton
          variant="secondary"
          onAction={async () => {
            const requestedGeneration = generation.current;
            const next = await action<Feed>("list_activity", pid, {
              ...filters,
              before: cursor,
            });
            if (generation.current !== requestedGeneration) return;
            setMore((v) => [...v, ...next.items]);
            setCursor(next.next_cursor);
          }}
        >
          Ещё события
        </AsyncButton>
      )}
    </div>
  );
}
