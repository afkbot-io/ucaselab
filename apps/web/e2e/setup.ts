import { request, type FullConfig } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const authDir = path.resolve("../../output/playwright/e2e/auth");
export const actors = [
  "owner",
  "manager",
  "tester",
  "developer",
  "outsider",
] as const;
export default async function setup(config: FullConfig) {
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  const identities: Record<
    string,
    { email: string; password: string; id: string }
  > = {};
  for (const role of actors) {
    const api = await request.newContext({
      baseURL: config.projects[0].use.baseURL,
    });
    const email = `e2e-${role}-${randomUUID()}@example.com`;
    const password = `E2e-only-${randomUUID()}`;
    const registered = await api.post("/api/auth/register", {
      data: { email, name: `E2E ${role}`, password },
    });
    if (registered.status() !== 202)
      throw Error(`Fixture registration ${role}: ${registered.status()}`);
    const login = await api.post("/api/auth/login", {
      data: { email, password },
    });
    if (!login.ok()) throw Error(`Fixture login ${role}: ${login.status()}`);
    const data = await login.json();
    identities[role] = { email, password, id: data.user.id };
    const file = path.join(authDir, role + ".json");
    await api.storageState({ path: file });
    await fs.chmod(file, 0o600);
    await api.dispose();
  }
  await fs.writeFile(
    path.join(authDir, "identities.json"),
    JSON.stringify(identities),
    { mode: 0o600 },
  );
}
