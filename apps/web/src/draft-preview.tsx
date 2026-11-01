import { useEffect, useRef, useState } from "react";
import { legacyCaseDrafts, unassignedProposalDrafts } from "./editor-drafts";
import { useSession } from "./context";
import type { Account, CaseContent, Specification } from "./types";
import type { CaseDraft, ProposalDraft } from "./editor-drafts";
import { useProject } from "./context";
import { action } from "./api";
import type { Folder } from "./types";
import { useLoad } from "./ui";

function ContentPreview({ content }: { content: CaseContent }) {
  const { project } = useProject();
  const links = useLoad(async () => {
    const [specifications, accounts] = await Promise.all([
      Promise.all(content.specifications.map((link) => action<Specification>("get_specification", project.id, { specification_id: link.specification_id }).catch(() => null))),
      Promise.all(content.accounts.map((link) => action<Account>("get_test_account", project.id, { account_id: link.account_id }).catch(() => null))),
    ]);
    return { specifications, accounts };
  }, [project.id, content.specifications.map((link) => link.specification_id).join(), content.accounts.map((link) => link.account_id).join()]);
  return <article className="draft-preview">
    <h3>{content.title || "Без названия"}</h3>
    <p><strong>Цель:</strong> {content.goal || "Не указана"}</p>
    <p><strong>Предусловия:</strong> {content.preconditions || "Не указаны"}</p>
    <ol>{content.steps.map((step) => <li key={step.key}><p>{step.action || "Действие не указано"}</p><p>Ожидается: {step.expected || "Не указано"}</p></li>)}</ol>
    {content.variants.map((variant) => <section key={variant.key}>
      <h4>{variant.polarity === "positive" ? "Положительный" : "Отрицательный"} вариант: {variant.name || "Без названия"}</h4>
      <dl>{Object.entries(variant.inputs).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{String(value)}</dd></div>)}</dl>
      <p>{variant.expected}</p><p>{variant.notes}</p>
      <p>{variant.enabled ? "Включён в новые прогоны" : "Отключён для новых прогонов"}</p>
      {variant.steps_override && <ol>{variant.steps_override.map((step) => <li key={step.key}>{step.action} — {step.expected}</li>)}</ol>}
    </section>)}
    <p><strong>Очистка:</strong> {content.cleanup || "Не указана"}</p>
    <p><strong>Приоритет:</strong> {({ low: "Низкий", normal: "Обычный", high: "Высокий", critical: "Критический" } as Record<string, string>)[content.priority] || content.priority}</p>
    <p><strong>Теги:</strong> {content.tags.join(", ") || "Нет"}</p>
    <p><strong>Платформы:</strong> {content.platforms.join(", ") || "Нет"}</p>
    <p><strong>Спецификации:</strong> {content.specifications.length === 0 ? "Нет" : ""}</p>
    <ul>{content.specifications.map((link, index) => <li key={link.specification_id}>
      {links.data?.specifications[index]?.title || "Спецификация недоступна или загружается"}
      {link.revision_id ? " (закреплённая версия)" : " (актуальная версия)"}
    </li>)}</ul>
    <p><strong>Тестовые аккаунты:</strong> {content.accounts.length === 0 ? "Нет" : ""}</p>
    <ul>{content.accounts.map((link, index) => <li key={link.account_id}>
      {link.alias}: {links.data?.accounts[index]?.name || "Аккаунт недоступен или загружается"}
    </li>)}</ul>
  </article>;
}
export function CaseDraftPreview({ value }: { value: CaseDraft }) {
  const { project } = useProject();
  const folder = useLoad(() => value.folder ? action<Folder>("get_folder", project.id, { folder_id: value.folder }) : Promise.resolve(null), [project.id, value.folder]);
  return <div><ContentPreview content={value.content} />
    <p><strong>Папка:</strong> {!value.folder ? "Без папки" : folder.data?.path.map((p) => p.name).join(" / ") || "Папка недоступна или загружается"}</p>
    <p><strong>Что изменилось:</strong> {value.message || "Не указано"}</p>
  </div>;
}
export function ProposalDraftPreview({ value }: { value: ProposalDraft }) {
  return <article className="draft-preview">
    <h3>{value.title || "Без названия"}</h3>
    <p>{({ new_use_case: "Новый юзер-кейс", update_use_case: "Изменение юзер-кейса", implementation_change: "Изменение кода", feature_idea: "Идея для проекта" } as Record<string, string>)[value.kind] || "Предложение"}</p>
    <p>{value.description}</p>
    <p>{({ unknown: "Влияние нужно проверить", behavior_changed: "Изменились действия или результат", no_behavior_change: "Поведение осталось прежним" } as Record<string, string>)[value.impact] || "Влияние нужно проверить"}</p>
    {value.target.map((target) => <p key={target.id}>Кейс: {target.label}</p>)}
    {value.items.map((item, index) => <section key={index}>{item.content && <ContentPreview content={item.content} />}{item.note && <p>{item.note}</p>}</section>)}
    {value.repository && <p>Репозиторий: {value.repository}</p>}
    {value.sha && <p>Коммит: {value.sha}</p>}
    {value.pr && <p>Pull request: {value.pr}</p>}
    {value.fingerprint && <p>Отпечаток diff: {value.fingerprint}</p>}
  </article>;
}


/** V1 has no stable object ID: offer explicit copying, never infer ownership by title. */
export function LegacyCaseDrafts() {
  const { user } = useSession();
  const { project } = useProject();
  const [drafts] = useState(() => legacyCaseDrafts(user.id, project.id));
  return <CaseDraftCopies drafts={drafts} heading="Черновики предыдущей версии" explanation="Эти черновики сохранены без ID кейса. Сравните текст и самостоятельно выберите, куда его скопировать. Текущий редактор и старые записи не изменяются." />;
}

export function UnassignedProposalDrafts({ context, activeIds, pendingId }: { context: string; activeIds: string[]; pendingId: string }) {
  const { user } = useSession();
  const { project } = useProject();
  const drafts = unassignedProposalDrafts(user.id, project.id, context, activeIds, pendingId);
  return <CaseDraftCopies drafts={drafts} heading="Несвязанные черновики сценариев" explanation="После изменения состава или версии предложения нельзя надёжно определить пункт этих черновиков. Сравните текст и при необходимости скопируйте его самостоятельно. Записи сохранены без изменений." />;
}

function CaseDraftCopies({ drafts, heading, explanation }: { drafts: { key: string; value: CaseDraft }[]; heading: string; explanation: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (selected) { copyField.current?.focus(); copyField.current?.select(); }
  }, [selected]);
  if (!drafts.length) return null;
  return <details className="legacy-drafts">
    <summary>{heading} ({drafts.length})</summary>
    <p className="note">{explanation}</p>
    {drafts.map(({ key, value }, index) => <details key={key}>
      <summary>Старый черновик {index + 1}: {value.content.title || "Без названия"}</summary>
      <CaseDraftPreview value={value} />
      <button type="button" className="text-link" onClick={() => setSelected(key)}>Подготовить текст для копирования</button>
      {selected === key && <>
        <label className="field">Текст старого черновика для копирования
          <textarea aria-label="Текст старого черновика для копирования" readOnly ref={copyField} rows={8} value={[
            value.content.title, "Цель: " + value.content.goal,
            "Предусловия: " + value.content.preconditions,
            ...value.content.steps.map((step, i) => `${i + 1}. ${step.action}\nОжидается: ${step.expected}`),
            ...value.content.variants.map((variant) => `${variant.polarity === "positive" ? "Положительный" : "Отрицательный"} вариант: ${variant.name}\n${Object.entries(variant.inputs).map(([name, input]) => `${name}: ${String(input)}`).join("\n")}\n${variant.expected}\n${variant.notes}\n${variant.enabled ? "Включён" : "Отключён"}\n${variant.steps_override?.map((step) => `${step.action} — ${step.expected}`).join("\n") || ""}`),
            "Очистка: " + value.content.cleanup, "Приоритет: " + value.content.priority,
            "Теги: " + value.content.tags.join(", "), "Платформы: " + value.content.platforms.join(", "),
            "Спецификации: " + value.content.specifications.map((link) => `${link.specification_id}${link.revision_id ? " / " + link.revision_id : ""}`).join(", "),
            "Аккаунты: " + value.content.accounts.map((link) => `${link.alias}: ${link.account_id}`).join(", "),
            "Папка: " + (value.folder || "Без папки"), "Что изменилось: " + value.message,
          ].join("\n\n")} />
        </label>
        <p>Текст выделен. Скопируйте его обычной командой браузера. Старая запись остаётся доступной после обновления.</p>
      </>}
    </details>)}
  </details>;
}
