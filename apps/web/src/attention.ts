import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { action } from "./api";
import { useLoad } from "./ui";

export type Attention = {
  project_id: string;
  unread_notifications: number;
  unread_activity: number;
  pending_proposals: number;
  assigned_runs: number;
  sections: Record<string, number>;
};

/** Refresh shared counters after writes, navigation, focus and background updates. */
export function useProjectAttention(projectId: string, role: string) {
  const location = useLocation();
  const data = useLoad(
    () => action<Attention>("get_project_attention", projectId),
    [projectId, role, location.pathname],
  );
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) data.reload();
    };
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ projectId: string }>).detail?.projectId ===
        projectId
      )
        refresh();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("ucaselab:changed", changed);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("ucaselab:changed", changed);
    };
  }, [projectId, data.reload]);
  return data.data?.project_id === projectId ? data.data : null;
}
