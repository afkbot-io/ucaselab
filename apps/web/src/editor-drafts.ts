import { useRef, useState } from "react";

/** Session-only, non-secret editor data. Callers mount with a stable identity key. */
export function useEditorDraft<T>(key: string, base: string, initial: T, validate: (value: unknown) => value is T, normalize?: (value: T) => T) {
  type Draft = { base: string; value: T };
  const read = (): Draft | null => {
    try {
      const draft: unknown = JSON.parse(sessionStorage.getItem(key) || "null");
      if (!isRecord(draft) || typeof draft.base !== "string" || !validate(draft.value)) return null;
      const value = normalize ? normalize(draft.value) : draft.value;
      if (value !== draft.value) {
        try { sessionStorage.setItem(key, JSON.stringify({ base: draft.base, value })); }
        catch { /* Keep authored text in memory even if migration cannot be persisted. */ }
      }
      return { base: draft.base, value };
    } catch {
      return null;
    }
  };
  const [stored] = useState(read);
  const [conflict, setConflict] = useState(
    stored && stored.base !== base ? stored : null,
  );
  const [value, setValue] = useState<T>(
    stored?.base === base ? stored.value : initial,
  );
  const [restored, setRestored] = useState(stored?.base === base);
  const current = useRef(value);
  function write(next: T) {
    current.current = next;
    // Persist synchronously: a child handoff can immediately unmount its parent.
    try {
      sessionStorage.setItem(key, JSON.stringify({ base, value: next }));
    } catch {
      // Restricted/full storage must not block explicit server saving.
    }
    setValue(next);
  }
  function update(change: (previous: T) => T) {
    write(change(current.current));
  }
  function clearSubmitted(submitted: T) {
    try {
      const current = read();
      if (current?.base === base && JSON.stringify(current.value) === JSON.stringify(submitted))
        sessionStorage.removeItem(key);
    } catch {
      // See write above.
    }
  }
  function reset() {
    const expected = conflict || { base, value: current.current };
    const saved = read();
    try {
      if (saved?.base === expected.base && JSON.stringify(saved.value) === JSON.stringify(expected.value))
        sessionStorage.removeItem(key);
    } catch { /* Explicit server saving remains available. */ }
    current.current = initial;
    setValue(initial);
    setConflict(null);
    setRestored(false);
  }
  function recover(local: boolean) {
    if (!local) return reset();
    write(conflict ? conflict.value : initial);
    setConflict(null);
    setRestored(true);
  }
  return { value, write, update, conflict, recover, restored, clearSubmitted, reset };
}

export function editorDraftKey(user: string, project: string, context: string) {
  return "ucaselab:editor:v2:" + JSON.stringify([user, project, context]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
const textFields = (value: Record<string, unknown>, names: string[]) =>
  names.every((name) => typeof value[name] === "string");
const optionalText = (value: unknown) => value == null || typeof value === "string";
const steps = (value: unknown) => Array.isArray(value) && value.every((step: unknown) =>
  isRecord(step) && textFields(step, ["key", "action", "expected"]));

function isCaseContent(value: unknown): value is import("./types").CaseContent {
  return isRecord(value) && textFields(value, ["title", "goal", "preconditions", "cleanup", "priority"]) &&
    strings(value.tags) && strings(value.platforms) && steps(value.steps) &&
    Array.isArray(value.accounts) && value.accounts.every((item: unknown) =>
      isRecord(item) && textFields(item, ["account_id", "alias"])) &&
    Array.isArray(value.specifications) && value.specifications.every((item: unknown) =>
      isRecord(item) && typeof item.specification_id === "string" && optionalText(item.revision_id)) &&
    Array.isArray(value.variants) && value.variants.every((item: unknown) =>
      isRecord(item) && textFields(item, ["key", "name", "expected", "notes"]) &&
      ["positive", "negative"].includes(String(item.polarity)) && typeof item.enabled === "boolean" &&
      (item.steps_override == null || steps(item.steps_override)) && isRecord(item.inputs) &&
      Object.values(item.inputs).every((input) => input === null || typeof input === "string" ||
        typeof input === "boolean" || (typeof input === "number" && Number.isFinite(input))));
}
export type CaseDraft = { content: import("./types").CaseContent; folder: string; message: string };
export function isCaseDraft(value: unknown): value is CaseDraft {
  return isRecord(value) && isCaseContent(value.content) && textFields(value, ["folder", "message"]);
}
export type ProposalDraft = {
  title: string; kind: string; description: string;
  target: import("./pickers").Choice[];
  repository: string; sha: string; pr: string; fingerprint: string; impact: string;
  items: import("./types").ProposalItem[]; itemIds: string[]; newItemId: string;
};
export function isProposalDraft(value: unknown): value is ProposalDraft {
  return isRecord(value) && textFields(value, ["title", "kind", "description", "repository", "sha", "pr", "fingerprint", "impact", "newItemId"]) &&
    Array.isArray(value.target) && value.target.every((item: unknown) =>
      isRecord(item) && textFields(item, ["id", "label"]) && optionalText(item.detail) && optionalText(item.revision_id)) &&
    strings(value.itemIds) &&
    Array.isArray(value.items) && value.items.length === value.itemIds.length && value.items.every((item: unknown) =>
      isRecord(item) && ["note", "create_use_case", "update_use_case"].includes(String(item.action)) &&
      optionalText(item.use_case_id) && optionalText(item.base_revision_id) && optionalText(item.folder_id) &&
      optionalText(item.note) && (item.content == null || isCaseContent(item.content)));
}


export function legacyCaseDrafts(user: string, project: string): { key: string; value: CaseDraft }[] {
  const prefix = `ucaselab:draft:${user}:${project}:`;
  const drafts: { key: string; value: CaseDraft }[] = [];
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith(prefix)) continue;
      try {
        const value: unknown = JSON.parse(sessionStorage.getItem(key) || "null");
        if (isRecord(value) && typeof value.original === "string" && isCaseDraft(value))
          drafts.push({ key, value: { content: value.content, folder: value.folder, message: value.message } });
      } catch { /* Unknown legacy records remain untouched. */ }
    }
  } catch { /* A restricted store must not block the editor. */ }
  return drafts;
}

type ItemIdentity = { version: number; items: string; ids: string[] };
const stableItemId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?::|$)/.test(id);

/** Migrate only identity metadata; old/ambiguous child input remains unassigned. */
export function normalizeProposalDraft(value: ProposalDraft): ProposalDraft {
  const counts = new Map<string, number>();
  for (const id of value.itemIds) counts.set(id, (counts.get(id) || 0) + 1);
  const itemIds = value.itemIds.map((id) => stableItemId(id) && counts.get(id) === 1
    ? id : crypto.randomUUID());
  const newItemId = stableItemId(value.newItemId) && !value.newItemId.includes(":") ? value.newItemId : crypto.randomUUID();
  return itemIds.every((id, index) => id === value.itemIds[index]) && newItemId === value.newItemId
    ? value : { ...value, itemIds, newItemId };
}
function itemSnapshot(items: import("./types").ProposalItem[]): string {
  // JSONB may return object keys in a different order after a reload.
  return JSON.stringify(items, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
}
function readItemIdentity(key: string): ItemIdentity | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) || "null");
    return isRecord(value) && typeof value.version === "number" && Number.isInteger(value.version) &&
      typeof value.items === "string" && strings(value.ids) && value.ids.every(Boolean) &&
      new Set(value.ids).size === value.ids.length
      ? { version: value.version, items: value.items, ids: value.ids } : null;
  } catch { return null; }
}

/** Only a known server snapshot or our own ordered save can establish child ownership. */
export function proposalItemIds(user: string, project: string, proposal: import("./types").Proposal): string[] {
  const key = editorDraftKey(user, project, `proposal:${proposal.id}:identities`);
  const stored = readItemIdentity(key);
  if (stored?.version === proposal.version && stored.items === itemSnapshot(proposal.content.items) &&
      stored.ids.length === proposal.content.items.length) {
    const ids = stored.ids.map((id) => stableItemId(id) ? id : crypto.randomUUID());
    if (ids.some((id, index) => id !== stored.ids[index])) rememberProposalItemIds(user, project, proposal, ids);
    return ids;
  }
  // An external revision has no item IDs. Never guess which identical item survived.
  const ids = proposal.content.items.map(() => crypto.randomUUID());
  rememberProposalItemIds(user, project, proposal, ids);
  return ids;
}

/** Keep the submitted item IDs after success; never clear pending child records. */
export function rememberProposalItemIds(user: string, project: string, proposal: import("./types").Proposal, ids: string[], fromContext?: string) {
  if (ids.length !== proposal.content.items.length || new Set(ids).size !== ids.length || !ids.every(stableItemId)) return;
  const context = `proposal:${proposal.id}`;
  const key = editorDraftKey(user, project, context + ":identities");
  try {
    if ((readItemIdentity(key)?.version || 0) > proposal.version) return;
    sessionStorage.setItem(key, JSON.stringify({ version: proposal.version, items: itemSnapshot(proposal.content.items), ids }));
    // A newly submitted proposal gains its server ID. Copy known children without
    // overwriting another record or deleting the original creation-context input.
    if (fromContext && fromContext !== context) for (const id of ids) {
      const source = sessionStorage.getItem(editorDraftKey(user, project, `${fromContext}:item:${id}`));
      const target = editorDraftKey(user, project, `${context}:item:${id}`);
      if (source && sessionStorage.getItem(target) === null) sessionStorage.setItem(target, source);
    }
  } catch { /* Storage restrictions must not turn a successful server save into an error. */ }
}

/** Unmapped/old positional children remain copyable, scoped and untouched. */
export function unassignedProposalDrafts(user: string, project: string, context: string, activeIds: string[], pendingId: string): { key: string; value: CaseDraft }[] {
  const drafts: { key: string; value: CaseDraft }[] = [];
  const prefix = context + ":item:";
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith("ucaselab:editor:v2:")) continue;
      try {
        const scope: unknown = JSON.parse(key.slice("ucaselab:editor:v2:".length));
        if (!Array.isArray(scope) || scope.length !== 3 || scope[0] !== user || scope[1] !== project ||
            typeof scope[2] !== "string" || !scope[2].startsWith(prefix)) continue;
        const id = scope[2].slice(prefix.length);
        if (activeIds.includes(id) || id.startsWith(pendingId + ":")) continue;
        const record: unknown = JSON.parse(sessionStorage.getItem(key) || "null");
        if (isRecord(record) && typeof record.base === "string" && isCaseDraft(record.value))
          drafts.push({ key, value: record.value });
      } catch { /* Unknown records are preserved, not displayed or removed. */ }
    }
  } catch { /* Restricted storage must not block the form. */ }
  return drafts;
}
