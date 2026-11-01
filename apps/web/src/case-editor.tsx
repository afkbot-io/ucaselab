import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { action } from "./api";
import { editorDraftKey, isCaseDraft, useEditorDraft } from "./editor-drafts";
import { useProject, useSession } from "./context";
import type { Account, CaseContent, Step, Variant } from "./types";
import { LegacyCaseDrafts, CaseDraftPreview } from "./draft-preview";
import { FolderPicker } from "./folder-ui";
import { emptyContent } from "./types";
import { LabelPicker, SearchPicker, SpecificationPicker } from "./pickers";
import { Button, Dialog, Field, Form, useLoad } from "./ui";

function StepRows({
  steps,
  onChange,
}: {
  steps: Step[];
  onChange: (v: Step[]) => void;
}) {
  return (
    <div className="editor-steps">
      {steps.map((s, index) => (
        <div className="editor-step" key={s.key}>
          <div className="step-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="step-fields">
            <Field label="Действие">
              <textarea
                required
                value={s.action}
                onChange={(e) =>
                  onChange(
                    steps.map((v) =>
                      v.key === s.key ? { ...v, action: e.target.value } : v,
                    ),
                  )
                }
                placeholder="Что нужно сделать"
                rows={2}
              />
            </Field>
            <Field label="Ожидаемый результат">
              <textarea
                value={s.expected}
                onChange={(e) =>
                  onChange(
                    steps.map((v) =>
                      v.key === s.key ? { ...v, expected: e.target.value } : v,
                    ),
                  )
                }
                placeholder="Что должно произойти"
                rows={2}
              />
            </Field>
          </div>
          <div className="step-controls">
            <button
              type="button"
              className="icon-button"
              disabled={index === 0}
              aria-label="Поднять шаг"
              onClick={() => {
                const v = [...steps];
                [v[index - 1], v[index]] = [v[index], v[index - 1]];
                onChange(v);
              }}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={index === steps.length - 1}
              aria-label="Опустить шаг"
              onClick={() => {
                const v = [...steps];
                [v[index + 1], v[index]] = [v[index], v[index + 1]];
                onChange(v);
              }}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Удалить шаг"
              onClick={() => onChange(steps.filter((v) => v.key !== s.key))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() =>
          onChange([
            ...steps,
            { key: crypto.randomUUID(), action: "", expected: "" },
          ])
        }
      >
        <Plus size={14} />
        Добавить шаг
      </Button>
    </div>
  );
}

function InputsEditor({
  inputs,
  onChange,
}: {
  inputs: Variant["inputs"];
  onChange: (v: Variant["inputs"]) => void;
}) {
  type Kind = "string" | "number" | "boolean" | "null";
  const [rows, setRows] = useState(() =>
    Object.entries(inputs).map(([name, value]) => ({
      id: crypto.randomUUID(),
      name,
      value: value === null ? "" : String(value),
      kind: (value === null ? "null" : typeof value) as Kind,
    })),
  );
  function update(next: typeof rows) {
    setRows(next);
    onChange(
      Object.fromEntries(
        next
          .filter((r) => r.name)
          .map((r) => [
            r.name,
            r.kind === "null"
              ? null
              : r.kind === "boolean"
                ? r.value === "true"
                : r.kind === "number"
                  ? Number(r.value)
                  : r.value,
          ]),
      ),
    );
  }
  function patch(id: string, changes: Partial<(typeof rows)[number]>) {
    update(rows.map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }
  return (
    <div className="inputs-editor">
      <span className="label-small">Данные</span>
      {rows.map((r) => (
        <div className="inline" key={r.id}>
          <input
            className="input"
            aria-label="Название параметра"
            required
            value={r.name}
            placeholder="email"
            ref={(node) => {
              node?.setCustomValidity(
                rows.filter((v) => v.name === r.name).length > 1
                  ? "Параметр с таким именем уже есть"
                  : "",
              );
            }}
            onChange={(e) => patch(r.id, { name: e.target.value })}
          />
          <select
            className="input data-type"
            aria-label="Тип значения"
            value={r.kind}
            onChange={(e) => {
              const kind = e.target.value as Kind;
              patch(r.id, {
                kind,
                value:
                  kind === "null"
                    ? ""
                    : kind === "boolean"
                      ? r.value === "true"
                        ? "true"
                        : "false"
                      : kind === "number"
                        ? Number.isFinite(Number(r.value))
                          ? r.value
                          : "0"
                        : r.value,
              });
            }}
          >
            <option value="string">Текст</option>
            <option value="number">Число</option>
            <option value="boolean">Да / нет</option>
            <option value="null">null</option>
          </select>
          {r.kind === "boolean" ? (
            <select
              className="input"
              aria-label="Значение параметра"
              value={r.value}
              onChange={(e) => patch(r.id, { value: e.target.value })}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              className="input"
              aria-label="Значение параметра"
              type={r.kind === "number" ? "number" : "text"}
              step={r.kind === "number" ? "any" : undefined}
              required={r.kind === "number"}
              disabled={r.kind === "null"}
              value={r.kind === "null" ? "null" : r.value}
              onChange={(e) => patch(r.id, { value: e.target.value })}
              placeholder={
                r.kind === "number" ? "0" : "Значение или пустая строка"
              }
            />
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Удалить параметр"
            onClick={() => update(rows.filter((v) => v.id !== r.id))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-link"
        onClick={() =>
          update([
            ...rows,
            { id: crypto.randomUUID(), name: "", value: "", kind: "string" },
          ])
        }
      >
        + Добавить параметр
      </button>
    </div>
  );
}

function VariantRows({
  variants,
  onChange,
  polarity,
}: {
  variants: Variant[];
  onChange: (v: Variant[]) => void;
  polarity: "positive" | "negative";
}) {
  const shown = variants.filter((v) => v.polarity === polarity);
  const update = (key: string, patch: Partial<Variant>) =>
    onChange(variants.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  return (
    <div className="stack">
      {shown.map((v, i) => (
        <div className="variant-editor" key={v.key}>
          <div className="inline spaced">
            <span className="label-small">Вариант {i + 1}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Удалить вариант"
              onClick={() => onChange(variants.filter((a) => a.key !== v.key))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <Field label="Название варианта">
            <input
              required
              value={v.name}
              onChange={(e) => update(v.key, { name: e.target.value })}
              placeholder={
                polarity === "positive"
                  ? "Новый email и допустимый пароль"
                  : "Некорректный формат email"
              }
            />
          </Field>
          <InputsEditor
            inputs={v.inputs}
            onChange={(inputs) => update(v.key, { inputs })}
          />
          <Field label="Ожидаемое поведение">
            <textarea
              required
              value={v.expected}
              onChange={(e) => update(v.key, { expected: e.target.value })}
              placeholder={
                polarity === "positive"
                  ? "Аккаунт создан, открыта страница подтверждения"
                  : "Показана ошибка формата почты, аккаунт не создан"
              }
            />
          </Field>
          <Field label="Примечание">
            <input
              value={v.notes}
              onChange={(e) => update(v.key, { notes: e.target.value })}
              placeholder="Особенности подготовки или проверки"
            />
          </Field>
          <label className="check-label">
            <input
              type="checkbox"
              checked={v.enabled}
              onChange={(e) => update(v.key, { enabled: e.target.checked })}
            />
            Включать в новые прогоны
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={!!v.steps_override}
              onChange={(e) =>
                update(v.key, {
                  steps_override: e.target.checked
                    ? [{ key: crypto.randomUUID(), action: "", expected: "" }]
                    : null,
                })
              }
            />
            У этого варианта другой путь прохождения
          </label>
          {v.steps_override && (
            <StepRows
              steps={v.steps_override}
              onChange={(steps_override) => update(v.key, { steps_override })}
            />
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() =>
          onChange([
            ...variants,
            {
              key: crypto.randomUUID(),
              name: "",
              polarity,
              inputs: {},
              expected: "",
              notes: "",
              enabled: true,
              steps_override: null,
            },
          ])
        }
      >
        <Plus size={14} />
        Добавить {polarity === "positive"
          ? "положительный"
          : "отрицательный"}{" "}
        вариант
      </Button>
    </div>
  );
}

export function CaseEditor({
  initial,
  draftId,
  revision,
  folderId,
  onSave,
  onClose,
  title = "Новый юзер-кейс",
}: {
  initial?: CaseContent;
  draftId: string;
  revision?: string;
  folderId?: string | null;
  onSave: (
    content: CaseContent,
    folder_id: string | null,
    message: string,
  ) => Promise<void>;
  onClose: () => void;
  title?: string;
}) {
  const { project } = useProject();
  const { user } = useSession();
  const draft = useEditorDraft(
    editorDraftKey(user.id, project.id, draftId),
    JSON.stringify([revision, initial || null, folderId || ""]),
    { content: structuredClone(initial || emptyContent()), folder: folderId || "", message: "" },
    isCaseDraft,
  );
  const titleInput = useRef<HTMLInputElement>(null);
  const { content, folder, message } = draft.value;
  const set = (content: CaseContent) => draft.write({ ...draft.value, content });
  const setFolder = (folder: string) => draft.write({ ...draft.value, folder });
  const setMessage = (message: string) => draft.write({ ...draft.value, message });
  const related = useLoad(async () => {
    const accounts = await Promise.all(
      content.accounts.map((a) =>
        action<Account>("get_test_account", project.id, {
          account_id: a.account_id,
        }),
      ),
    );
    return { accounts };
  }, [project.id, content.accounts.map((a) => a.account_id).join()]);
  const patch = (p: Partial<CaseContent>) => set({ ...content, ...p });
  return (
    <Dialog title={title} onClose={onClose} wide className="case-editor-dialog">
      <Form
        onSubmit={async () => {
          if (draft.conflict) throw new Error("Сначала выберите версию текста");
          const submitted = draft.value;
          await onSave(content, folder || null, message || "Обновлён сценарий");
          draft.clearSubmitted(submitted);
        }}
      >
        {draft.conflict ? (
          <section className="draft-recovery" aria-label="Восстановление черновика">
            <LegacyCaseDrafts />
            <p className="note">Исходные данные изменились. На сервере могла появиться новая версия или измениться папка. Локальные изменения сохранены отдельно. Сравните тексты перед восстановлением; сохранение остаётся явным.</p>
            <details><summary>Локальный текст</summary><CaseDraftPreview value={draft.conflict.value} /></details>
            <details><summary>Текст при открытии</summary><CaseDraftPreview value={draft.value} /></details>
            <div className="form-footer">
              <Button type="button" variant="secondary" onClick={onClose}>Решить позже</Button>
              <Button type="button" variant="secondary" onClick={() => draft.recover(false)}>Удалить локальный черновик</Button>
              <Button type="button" onClick={() => draft.recover(true)}>Восстановить локальный текст</Button>
            </div>
          </section>
        ) : <>
        {draft.restored && <div className="note inline spaced"><span>Вернули несохранённые изменения. Проверьте текст перед сохранением.</span><button type="button" className="text-link" onClick={() => { draft.reset(); titleInput.current?.focus(); }}>Начать заново</button></div>}
        <div className="case-editor-grid">
          <div>
            <LegacyCaseDrafts />
            <Field label="Название функционала">
              <input
                ref={titleInput}
                autoFocus
                required
                value={content.title}
                maxLength={240}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="Регистрация пользователя"
              />
            </Field>
            <Field label="Цель">
              <textarea
                value={content.goal}
                onChange={(e) => patch({ goal: e.target.value })}
                placeholder="Что пользователь сможет сделать, пройдя этот сценарий"
              />
            </Field>
            <Field label="Предусловия">
              <textarea
                value={content.preconditions}
                onChange={(e) => patch({ preconditions: e.target.value })}
                placeholder="Что нужно подготовить перед выполнением"
              />
            </Field>
            <div className="editor-section">
              <h3>Шаги прохождения</h3>
              <p>
                Опишите путь пользователя: что он делает и какой результат видит
                после каждого шага.
              </p>
              <StepRows
                steps={content.steps}
                onChange={(steps) => patch({ steps })}
              />
            </div>
            <div className="editor-section references-section">
              <SpecificationPicker
                links={content.specifications}
                onChange={(specifications) => patch({ specifications })}
              />
            </div>
            <div className="editor-section">
              <h3>
                <span className="polarity-dot positive" />
                Положительные данные
              </h3>
              <p>
                Добавьте данные для успешного прохождения: например, новый адрес
                почты и подходящий пароль.
              </p>
              <VariantRows
                variants={content.variants}
                polarity="positive"
                onChange={(variants) => patch({ variants })}
              />
            </div>
            <div className="editor-section">
              <h3>
                <span className="polarity-dot negative" />
                Отрицательные данные
              </h3>
              <p>
                Опишите ошибки ввода и ограничения: какие данные нужно отклонить
                и что показать пользователю.
              </p>
              <VariantRows
                variants={content.variants}
                polarity="negative"
                onChange={(variants) => patch({ variants })}
              />
            </div>
            <Field label="Очистка после выполнения">
              <textarea
                value={content.cleanup}
                onChange={(e) => patch({ cleanup: e.target.value })}
                placeholder="Например, удалить созданный тестовый аккаунт"
              />
            </Field>
          </div>
          <aside>
            <FolderPicker
              label="Папка"
              rootLabel="Без папки"
              value={folder}
              onChange={setFolder}
            />
            <Field label="Приоритет">
              <select
                value={content.priority}
                onChange={(e) => patch({ priority: e.target.value })}
              >
                <option value="low">Низкий</option>
                <option value="normal">Обычный</option>
                <option value="high">Высокий</option>
                <option value="critical">Критический</option>
              </select>
            </Field>
            <LabelPicker
              label="Теги"
              scope="use_cases"
              values={content.tags}
              onChange={(tags) => patch({ tags })}
              hint="Выберите тег из списка или добавьте новый по Enter."
            />
            <LabelPicker
              label="Платформы"
              scope="platforms"
              values={content.platforms}
              onChange={(platforms) => patch({ platforms })}
            />
            <div className="divider" />
            <SearchPicker
              label="Тестовые аккаунты"
              values={content.accounts.map((a) => ({
                id: a.account_id,
                label:
                  related.data?.accounts.find((v) => v.id === a.account_id)
                    ?.name || a.alias,
              }))}
              placeholder="Найти аккаунт…"
              maxSelected={30}
              hint="Выберите аккаунты, которые нужны для этих шагов. Пароль будет доступен исполнителю отдельно."
              onChange={(v) =>
                patch({
                  accounts: v.map(
                    (o) =>
                      content.accounts.find((a) => a.account_id === o.id) || {
                        account_id: o.id,
                        alias: "actor" + (content.accounts.length || ""),
                      },
                  ),
                })
              }
              loadOptions={async (search, offset) => {
                const r = await action<{
                  items: Account[];
                  total: number;
                  next_offset: number | null;
                }>("list_test_accounts", project.id, {
                  search,
                  offset,
                  limit: 20,
                });
                return {
                  ...r,
                  items: r.items.map((a) => ({
                    id: a.id,
                    label: a.name,
                    detail: a.login,
                  })),
                };
              }}
            />
            {content.accounts.map((link) => (
              <Field
                key={link.account_id}
                label={`Имя в сценарии: ${related.data?.accounts.find((a) => a.id === link.account_id)?.name || link.alias}`}
                hint="Например: actor или recipient."
              >
                <input
                  required
                  value={link.alias}
                  onChange={(e) =>
                    patch({
                      accounts: content.accounts.map((a) =>
                        a.account_id === link.account_id
                          ? { ...a, alias: e.target.value }
                          : a,
                      ),
                    })
                  }
                  placeholder="actor"
                />
              </Field>
            ))}
            {content.accounts.length > 0 && (
              <details className="context-help">
                <summary>Как использовать пароль в данных</summary>
                <p>
                  Вместо пароля укажите <code>@account:actor:password</code>.
                  Замените actor на имя аккаунта в этом сценарии. Агент запросит
                  пароль с вашим разрешением.
                </p>
              </details>
            )}
            {related.error && <p className="error">{related.error.message}</p>}
          </aside>
        </div>
        <div className="editor-save">
          <Field label="Что изменилось">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Краткое описание для истории"
            />
          </Field>
          <div className="form-footer">
            <Button type="button" variant="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit">Сохранить черновик</Button>
          </div>
        </div>
        </>}
      </Form>
    </Dialog>
  );
}
