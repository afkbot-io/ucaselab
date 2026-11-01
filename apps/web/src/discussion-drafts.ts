import { useCallback, useSyncExternalStore } from "react";
import type { Anchor } from "./types";

type Drafts = {
  anchor?: Anchor;
  messages: Record<string, string>;
  replies: Record<string, string>;
  edits: Record<string, string>;
};

// Memory only: survives panel/route unmounts in this tab, never a browser reload.
// Every entry belongs to one authenticated user, project, target type and target ID.
const drafts = new Map<string, Drafts>();
const listeners = new Set<() => void>();
export const anchorKey = (anchor?: Anchor) =>
  anchor
    ? JSON.stringify([
        anchor.revision_id,
        anchor.field_path,
        anchor.step_key,
        anchor.variant_key,
        anchor.quote,
      ])
    : "general";

export function useDiscussionDrafts(scope: string) {
  if (!drafts.has(scope))
    drafts.set(scope, { messages: {}, replies: {}, edits: {} });
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const snapshot = useCallback(() => drafts.get(scope)!, [scope]);
  const value = useSyncExternalStore(subscribe, snapshot);
  const update = useCallback(
    (change: (current: Drafts) => Drafts) => {
      drafts.set(scope, change(drafts.get(scope)!));
      listeners.forEach((listener) => listener());
    },
    [scope],
  );
  return [value, update] as const;
}
