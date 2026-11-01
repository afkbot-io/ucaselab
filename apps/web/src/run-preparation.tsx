import { useEffect, useId, useState } from "react";
import { CheckCircle2, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { action } from "./api";
import { useProject } from "./context";
import type {
  CaseSource,
  ReadinessChecks,
  ReadinessState,
  Run,
  RunReadiness,
} from "./types";
import {
  AsyncButton,
  Button,
  ErrorState,
  Field,
  Form,
  Loading,
  date,
  useLoad,
} from "./ui";

/** Saved preparation is part of the run/report, not a live readiness guarantee. */
export function ReadinessSummary({
  run,
}: {
  run: Pick<Run, "environment" | "build" | "readiness" | "case_source">;
}) {
  const record = run.readiness;
  const labels = {
    ready: "Подтверждено",
    blocked: "Есть препятствие",
    not_checked: "Не проверено",
    not_required: "Не требуется",
  };
  return (
    <details className="saved-readiness">
      <summary>
        Условия проверки
        {record.allow_partial ? " · запуск с ограничениями" : ""}
      </summary>
      <div>
        <p>
          {run.case_source === "draft"
            ? "Проверка черновиков"
            : "Проверка опубликованных версий"}{" "}
          · {run.environment.name || "Без отдельного окружения"} · Сборка:{" "}
          {run.build || "не указана"}
        </p>
        {run.environment.base_url && (
          <p>
            Адрес:{" "}
            <a
              className="text-link"
              href={run.environment.base_url}
              target="_blank"
              rel="noreferrer"
            >
              {run.environment.base_url}
            </a>
          </p>
        )}
        {record.checks ? (
          <dl>
            {(
              [
                ["environment", "Стенд"],
                ["accounts", "Аккаунты"],
                ["dependencies", "Почта и инструменты"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{labels[record.checks![key]]}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>
            В этом историческом прогоне подготовка отдельно не фиксировалась.
          </p>
        )}
        {record.notes && (
          <p className="readiness-saved-notes">{record.notes}</p>
        )}
        {record.checked_at && (
          <small>Подготовка сохранена {date(record.checked_at)}</small>
        )}
      </div>
    </details>
  );
}

export function CaseSourceField({
  value,
  change,
}: {
  value: CaseSource;
  change: (value: CaseSource) => void;
}) {
  const hintId = useId();
  return (
    <>
      <Field label="Какие версии проверяем?">
        <select
          aria-describedby={hintId}
          value={value}
          onChange={(e) => change(e.target.value as CaseSource)}
        >
          <option value="published">Последние опубликованные версии</option>
          <option value="draft">Текущие черновики</option>
        </select>
      </Field>
      <p id={hintId} className="field-hint">
        {value === "draft"
          ? "Сохраним снимок рабочей ревизии. Кейсы останутся черновиками; прогон и отчёт доступны тестировщикам и руководителям."
          : "Сохраним опубликованные шаги и данные. Неопубликованные изменения в этот прогон не попадут."}
      </p>
    </>
  );
}

export function RunReadinessPanel({
  run,
  begin,
  refresh,
}: {
  run: Pick<Run, "id" | "version">;
  begin: () => Promise<void>;
  refresh: () => void;
}) {
  const { project } = useProject();
  const data = useLoad(
    () =>
      action<RunReadiness>("get_run_readiness", project.id, { run_id: run.id }),
    [project.id, run.id, run.version],
  );
  const [checks, setChecks] = useState<ReadinessChecks>({
    environment: "not_checked",
    accounts: "not_checked",
    dependencies: "not_checked",
  });
  const [url, setUrl] = useState(""),
    [notes, setNotes] = useState(""),
    [partial, setPartial] = useState(false),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!data.data) return;
    setChecks(data.data.checks);
    setUrl(data.data.environment.base_url || "");
    setNotes(data.data.assessment.notes || "");
    setPartial(data.data.assessment.allow_partial || false);
    setDirty(false);
  }, [data.data]);
  if (data.loading && !data.data) return <Loading />;
  if (data.error || !data.data)
    return <ErrorState error={data.error} retry={data.reload} />;
  const readiness = data.data;
  const stateSelect = (key: keyof ReadinessChecks, label: string) => (
    <Field label={label}>
      <select
        value={checks[key]}
        onChange={(e) => {
          setChecks({ ...checks, [key]: e.target.value as ReadinessState });
          setDirty(true);
        }}
      >
        <option value="not_checked">Ещё не проверено</option>
        <option value="ready">Проверено, доступно</option>
        <option value="blocked">Есть препятствие</option>
        {key !== "environment" && (
          <option value="not_required">Не требуется для этих проверок</option>
        )}
      </select>
    </Field>
  );
  return (
    <section className="run-readiness" aria-labelledby="run-readiness-title">
      <header>
        <div>
          <h2 id="run-readiness-title">Перед началом</h2>
          <p>
            Откройте стенд и проверьте доступы. Зафиксируйте, что готово и чего
            не хватает для выполнения выбранных сценариев.
          </p>
        </div>
        <span className={"readiness-state " + (readiness.ready ? "ready" : "")}>
          {dirty ? "Есть несохранённые изменения" : readiness.message}
        </span>
      </header>
      <Form
        onSubmit={async () => {
          const saved = await action<RunReadiness>(
            "confirm_run_readiness",
            project.id,
            {
              run_id: run.id,
              expected_version: readiness.run_version,
              checks,
              notes,
              allow_partial: partial,
              ...(url.trim() ? { actual_base_url: url.trim() } : {}),
            },
          );
          data.setData(saved);
          refresh();
        }}
      >
        <div className="readiness-columns">
          <div>
            <h3>Стенд и сборка</h3>
            <Field label="Адрес приложения">
              <input
                type="url"
                value={url}
                maxLength={2000}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setDirty(true);
                }}
                placeholder="https://dev.example.com"
              />
            </Field>
            {url && /^https?:\/\//.test(url) && (
              <a
                className="text-link"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                Открыть приложение ↗
              </a>
            )}
            <p className="field-hint">
              Сборка: {readiness.build || "не указана"}. Исправленный адрес
              сохранится только в этом прогоне.
            </p>
            {stateSelect("environment", "Стенд открывается?")}
          </div>
          <div>
            <h3>Тестовые аккаунты</h3>
            {readiness.accounts.length ? (
              <ul className="readiness-accounts">
                {readiness.accounts.map((a) => (
                  <li key={a.id}>
                    <Link
                      className="text-link"
                      to={`/p/${project.id}/accounts?open=${a.id}`}
                    >
                      {a.name}
                    </Link>
                    <small>
                      {a.login || "Логин не указан"}
                      {!a.available && " · требует подготовки"}
                      {!a.has_secret && " · секрет не сохранён"}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                С кейсами не связаны аккаунты. Если сценарий требует входа,
                подготовьте доступ и свяжите аккаунт с кейсом перед созданием
                нового прогона.
              </p>
            )}
            {stateSelect("accounts", "Доступы для проверки готовы?")}
          </div>
          <div>
            <h3>Почта и инструменты</h3>
            <p>
              Проверьте доступ к тестовому ящику, CAPTCHA, браузеру или
              устройству, если они нужны по предусловиям.
            </p>
            {stateSelect("dependencies", "Зависимости доступны?")}
          </div>
        </div>
        {readiness.issues.some((i) => i.blocking) && (
          <div className="error">
            {readiness.issues
              .filter((i) => i.blocking)
              .map((i) => (
                <p key={i.code + i.message}>{i.message}</p>
              ))}
          </div>
        )}
        <Field label="Пояснение к подготовке">
          <textarea
            value={notes}
            maxLength={10000}
            rows={2}
            onChange={(e) => {
              setNotes(e.target.value);
              setDirty(true);
            }}
            placeholder="Что проверили, какие доступы отсутствуют и какую часть можно выполнить. Пароли и коды сюда не добавляйте."
            required={partial}
          />
        </Field>
        <label className="check-label">
          <input
            type="checkbox"
            checked={partial}
            onChange={(e) => {
              setPartial(e.target.checked);
              setDirty(true);
            }}
          />
          Начать с ограничениями и сохранить их в отчёте
        </label>
        {partial && (
          <p className="field-hint">
            Недоступные проверки отмечайте «Не удалось проверить» с причиной.
            Ограничения не подтверждают готовность стенда или аккаунтов.
          </p>
        )}
        <div className="readiness-footer">
          <span>
            {readiness.assessment.checked_at && (
              <>
                <CheckCircle2 size={15} />
                Подготовка сохранена {date(readiness.assessment.checked_at)}
              </>
            )}
          </span>
          <Button type="submit" variant="secondary">
            Сохранить подготовку
          </Button>
          <AsyncButton
            type="button"
            disabled={dirty || !readiness.can_start}
            onAction={begin}
          >
            <Play size={15} />
            Начать проверку
          </AsyncButton>
        </div>
      </Form>
    </section>
  );
}
