let csrf = "";
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const response = await fetch("/api" + path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new ApiError(
      typeof detail === "string"
        ? detail
        : detail?.message || "Не удалось выполнить запрос",
      detail?.code || "REQUEST_FAILED",
      response.status,
    );
  }
  if (data.csrf) csrf = data.csrf;
  return data;
}
const pendingMutations = new Map<string, string>();
export async function action<T>(
  name: string,
  project_id: string | null = null,
  arguments_: Record<string, unknown> = {},
): Promise<T> {
  const write =
    /^(create|save|prepare|confirm|update|delete|move|rename|copy|archive|publish|restore|accept|reject|withdraw|start|begin|finish|record|retry|complete|cancel|assign|add|set|moderate|resolve|mark|subscribe|unsubscribe|generate|invite|revoke|remove|transfer|submit)_/.test(
      name,
    ) ||
    name === "subscribe" ||
    name === "unsubscribe";
  const payload = { project_id, arguments: arguments_ };
  let requestHash: string | undefined;
  let idempotency_key: string | undefined;
  if (write) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(name + JSON.stringify(payload)),
    );
    requestHash = Array.from(new Uint8Array(bytes))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    idempotency_key = pendingMutations.get(requestHash) || crypto.randomUUID();
    if (pendingMutations.size > 128)
      pendingMutations.delete(pendingMutations.keys().next().value!);
    pendingMutations.set(requestHash, idempotency_key);
  }
  try {
    const result = await request<T>("/actions/" + name, {
      method: "POST",
      body: JSON.stringify({ ...payload, idempotency_key }),
    });
    if (requestHash) pendingMutations.delete(requestHash);
    if (write)
      window.dispatchEvent(
        new CustomEvent("ucaselab:changed", {
          detail: { projectId: project_id, operation: name },
        }),
      );
    return result;
  } catch (error) {
    if (requestHash && error instanceof ApiError && error.status < 500)
      pendingMutations.delete(requestHash);
    throw error;
  }
}
export const auth = (name: string, data: unknown) =>
  request<{
    user?: { id: string; name: string; email: string };
    csrf?: string;
    message?: string;
    project_id?: string;
  }>("/auth/" + name, { method: "POST", body: JSON.stringify(data) });
