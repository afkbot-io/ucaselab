export type Theme = "system" | "light" | "dark";
export type User = {
  id: string;
  name: string;
  email: string;
  preferences: { theme: Theme };
};
export type Role = "developer" | "tester" | "manager" | "owner";
export type Project = {
  id: string;
  name: string;
  key: string;
  description: string;
  version: number;
  role: Role;
  archived: boolean;
  owner_id: string;
  guide?: string;
  can_read_secrets?: boolean;
  can_write_secrets?: boolean;
};
export type Folder = {
  kind: "use_cases" | "specifications";
  item_count: number;
  archived_item_count: number;
  total_item_count: number;
  position: number;
  path: { id: string; name: string }[];
  depth: number;
  use_case_count: number;
  archived_use_case_count: number;
  total_use_case_count: number;
  subfolder_count: number;
  id: string;
  name: string;
  parent_id: string | null;
  version: number;
  archived: boolean;
};
export type Step = { key: string; action: string; expected: string };
export type Variant = {
  key: string;
  name: string;
  polarity: "positive" | "negative";
  inputs: Record<string, string | number | boolean | null>;
  expected: string;
  notes: string;
  enabled: boolean;
  steps_override?: Step[] | null;
};
export type CaseContent = {
  title: string;
  goal: string;
  preconditions: string;
  cleanup: string;
  priority: string;
  tags: string[];
  platforms: string[];
  steps: Step[];
  variants: Variant[];
  specifications: { specification_id: string; revision_id?: string | null }[];
  accounts: { account_id: string; alias: string }[];
};
export type UseCase = {
  id: string;
  key: string;
  title: string;
  folder_id: string | null;
  version: number;
  revision_id: string;
  working_revision_id: string;
  current_publication_id: string | null;
  publication_number: number | null;
  has_unpublished_changes: boolean;
  priority: string;
  tags: string[];
  content: CaseContent;
  archived: boolean;
};
export type Specification = {
  viewed_revision_id?: string;
  viewed_revision_number?: number;
  id: string;
  folder_id: string | null;
  title: string;
  description: string;
  tags: string[];
  acceptance_criteria: string;
  version: number;
  current_revision_id: string;
  archived: boolean;
};
export type Environment = {
  id: string;
  name: string;
  base_url: string;
  description: string;
  configuration: Record<string, unknown>;
  version: number;
};
export type Account = {
  archived: boolean;
  id: string;
  name: string;
  login: string;
  description: string;
  application_role: string;
  environment_id: string | null;
  version: number;
  has_secret: boolean;
};
export type Member = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: Role;
  can_read_secrets: boolean;
  can_write_secrets: boolean;
};
export type PlanItem = {
  use_case_id: string;
  version_policy: "latest_published" | "fixed_publication";
  publication_id: string | null;
  variant_selection: "all_enabled" | "explicit";
  variant_keys: string[];
  assignee_id: string | null;
};
export type PlanContent = {
  title: string;
  purpose: string;
  items: PlanItem[];
  environment_id: string | null;
};
export type Plan = {
  id: string;
  title: string;
  status: string;
  version: number;
  current_revision_id: string;
  content: PlanContent;
  archived: boolean;
};
export type Status =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "scenario_issue"
  | "blocked"
  | "skipped"
  | "cancelled";
export type Summary = {
  selected: number;
  counts: Record<Status, number>;
  coverage: number | null;
  pass_rate: number | null;
};
export type Execution = {
  id: string;
  attempt: number;
  status: Status;
  actor_id: string | null;
  actor_name?: string | null;
  attachments?: {
    id: string;
    filename: string;
    size: number;
    sha256: string;
  }[];
  annotations?: {
    id: string;
    body: string;
    author_id: string;
    created_at: string;
  }[];
  actual_result: string;
  source: string;
  steps: Record<string, { status: Status; actual_result: string }>;
  finished_at: string | null;
  started_at: string | null;
  external_issue_url: string;
};
export type RunItem = {
  id: string;
  use_case_id: string;
  publication_id: string | null;
  revision_id: string;
  variant_key: string | null;
  assignee_id: string | null;
  snapshot: {
    key: string;
    publication_number: number | null;
    case_source?: CaseSource;
    revision_number?: number;
    content: CaseContent;
    variant: Variant | null;
    accounts: Account[];
  };
  attempts: Execution[];
};
export type Run = {
  id: string;
  title: string;
  status: string;
  version: number;
  build: string;
  environment: Partial<Environment>;
  summary: Summary;
  items: RunItem[];
  created_at: string;
  finished_at: string | null;
  plan_revision_id: string | null;
  case_source: CaseSource;
  readiness: ReadinessRecord;
};
export type CaseSource = "published" | "draft";
export type ReadinessState =
  | "ready"
  | "blocked"
  | "not_checked"
  | "not_required";
export type ReadinessChecks = {
  environment: Exclude<ReadinessState, "not_required">;
  accounts: ReadinessState;
  dependencies: ReadinessState;
};
export type ReadinessRecord = {
  required?: boolean;
  checks?: ReadinessChecks;
  notes?: string;
  allow_partial?: boolean;
  checked_at?: string;
  checked_by?: string;
};
export type RunReadiness = {
  checks: ReadinessChecks;
  accounts: {
    id: string;
    name: string;
    login: string;
    available: boolean;
    has_secret: boolean;
  }[];
  issues: { code: string; message: string; blocking: boolean }[];
  ready: boolean;
  can_start: boolean;
  confirmed: boolean;
  legacy: boolean;
  assessment: ReadinessRecord;
  environment: Partial<Environment>;
  build: string;
  run_version: number;
  message: string;
};
export function caseVersion(snapshot: {
  case_source?: CaseSource;
  publication_number: number | null;
  revision_number?: number | null;
}): string {
  return snapshot.case_source === "draft"
    ? `Черновик r${snapshot.revision_number ?? "?"}`
    : `v${snapshot.publication_number}`;
}
export type Proposal = {
  id: string;
  title: string;
  kind: string;
  status: string;
  author_id: string;
  version: number;
  target_use_case_id: string | null;
  content: {
    description: string;
    items: ProposalItem[];
    repository: string;
    commit_sha: string;
    pull_request_url: string;
    diff_fingerprint: string;
    impact: string;
  };
  decision: null | {
    reason: string;
    actor_id: string;
    applied_items?: { use_case_id: string; revision_id: string }[];
  };
  created_at: string;
};
export type ProposalItem = {
  action: "note" | "create_use_case" | "update_use_case";
  use_case_id?: string | null;
  base_revision_id?: string | null;
  folder_id?: string | null;
  content?: CaseContent | null;
  note?: string;
};
export type Comment = {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
  deleted: boolean;
  updated_at: string | null;
};
export type Anchor = {
  revision_id: string;
  field_path: string;
  step_key?: string;
  variant_key?: string;
  quote?: string;
};
export type Thread = {
  target_type: string;
  target_id: string;
  path: string;
  id: string;
  author_id: string;
  resolved: boolean;
  anchor: Anchor | null;
  anchor_status: string | null;
  visibility: string;
  comments: Comment[];
  created_at: string;
};
export type Report = {
  id: string;
  title: string;
  audience: string;
  interim: boolean;
  created_at: string;
  content_hash: string;
  snapshot: {
    project: Project;
    generated_at: string;
    methodology: string;
    runs: Run[];
  };
};
export const roles: Record<Role, string> = {
  developer: "Разработчик",
  tester: "Тестировщик",
  manager: "Менеджер",
  owner: "Руководитель",
};
export const statusLabels: Record<string, string> = {
  draft: "Черновик",
  active: "Активен",
  published: "Опубликован",
  open: "На рассмотрении",
  accepted: "Принято",
  rejected: "Отклонено",
  withdrawn: "Отозвано",
  queued: "Ожидает",
  running: "Выполняется",
  completed: "Завершён",
  passed: "Успешно",
  failed: "Ошибка приложения",
  scenario_issue: "Неточность сценария",
  blocked: "Не удалось проверить",
  skipped: "Пропущено",
  cancelled: "Отменено",
};
export const emptyContent = (): CaseContent => ({
  title: "",
  goal: "",
  preconditions: "",
  cleanup: "",
  priority: "normal",
  tags: [],
  platforms: [],
  steps: [{ key: crypto.randomUUID(), action: "", expected: "" }],
  variants: [],
  specifications: [],
  accounts: [],
});
