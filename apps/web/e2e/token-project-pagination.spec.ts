import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { authDir } from "./setup";
import type { Project } from "../src/types";

// This owner never joins the suite's shared projects or grows its catalogue.
test.use({ storageState: path.join(authDir, "token-pagination.json") });

test("token catalogue includes later pages and preserves the same bearer through page failures", async ({ page }, info) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const me = await page.request.get("/api/auth/me");
  expect(me.ok()).toBeTruthy();
  const { csrf } = await me.json();
  const headers = { "X-CSRF-Token": csrf };
  const call = async <T,>(name: string, args: Record<string, unknown> = {}) => {
    const response = await page.request.post("/api/actions/" + name, { headers, data: { arguments: args } });
    expect(response.ok(), `${name}: ${response.status()}`).toBeTruthy();
    return response.json() as Promise<T>;
  };
  const initial = await call<{ total: number }>("list_projects");
  const anchor = await call<Project>("create_project", { name: "Б исходный проект " + suffix, key: "B" + suffix.toUpperCase() });
  for (let index = 0; index < 500; index++) {
    await call("create_project", { name: `А каталог ${suffix} ${String(index).padStart(4, "0")}`, key: "P" + index });
  }
  const first = await call<{ items: Project[]; total: number; next_offset: number }>("list_projects");
  expect(first.total).toBe(initial.total + 501);
  expect(first.items).toHaveLength(500);
  expect(first.next_offset).toBe(500);
  expect(first.items.some(project => project.id === anchor.id)).toBe(false);

  await page.goto(`/p/${anchor.id}/profile?tab=mcp`);
  await page.getByRole("button", { name: "Создать токен", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Новый MCP-токен", exact: true });
  const name = "Доступ за первой страницей " + suffix;
  await create.getByLabel("Название", { exact: true }).fill(name);
  await expect(create.getByRole("checkbox", { name: anchor.name, exact: false })).toBeChecked();
  await create.getByRole("button", { name: "Создать токен", exact: true }).click();
  const reveal = page.getByRole("dialog", { name: "Сохраните токен сейчас", exact: true });
  const raw = await reveal.getByLabel("Созданный MCP-токен", { exact: true }).inputValue();
  await reveal.getByRole("button", { name: "Токен сохранён", exact: true }).click();
  const row = page.locator("tr").filter({ hasText: name });
  await expect(row).toContainText(anchor.name);
  await expect(row).not.toContainText("Недоступный проект");
  const before = (await (await page.request.get("/api/tokens")).json()).items.find((item: { name: string }) => item.name === name);
  const future = await call<Project>("create_project", { name: "Я новый доступный проект " + suffix, key: "F" + suffix.toUpperCase() });
  const context = (projectId: string) => page.request.post("/api/actions/get_project_context", {
    headers: { Authorization: "Bearer " + raw }, data: { project_id: projectId, arguments: {} },
  });
  expect((await context(anchor.id)).status()).toBe(200);
  expect((await context(future.id)).status()).toBe(404);
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Изменить доступ", exact: true });
  await expect(edit.getByRole("checkbox")).toHaveCount(first.total + 1);
  await expect(edit.getByRole("checkbox", { name: anchor.name, exact: false })).toBeChecked();
  await edit.getByRole("checkbox", { name: future.name, exact: false }).check();
  await edit.getByRole("checkbox", { name: anchor.name, exact: false }).uncheck();
  await edit.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText(future.name);
  await expect(row).not.toContainText("Недоступный проект");
  expect((await context(anchor.id)).status()).toBe(404);
  expect((await context(future.id)).status()).toBe(200);
  const saved = (await (await page.request.get("/api/tokens")).json()).items.find((item: { id: string }) => item.id === before.id);
  expect(saved.project_ids).toEqual([future.id]);
  expect(saved.expires_at).toBe(before.expires_at);
  expect(saved.prefix).toBe(before.prefix);

  // Only page two fails; page one remains a genuine access-checked server read.
  await page.route("**/api/actions/list_projects", route => {
    if ((route.request().postDataJSON().arguments?.offset || 0) >= 500) {
      return route.fulfill({ status: 500, json: { detail: { code: "TEST_ERROR", message: "Ошибка второй страницы каталога" } } });
    }
    return route.continue();
  });
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await expect(edit).toContainText("Ошибка второй страницы каталога");
  await expect(edit.getByRole("checkbox", { name: future.name, exact: false })).toBeChecked();
  await expect(edit.getByRole("checkbox", { name: future.name, exact: false })).toBeEnabled();
  await expect(edit).not.toContainText("Недоступный проект");
  await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("token-page-two-error.png"), fullPage: true });
  await page.unroute("**/api/actions/list_projects");
  let retryWrites = 0;
  page.on("request", request => {
    if (request.method() === "PATCH" && request.url().includes("/api/tokens/")) retryWrites++;
  });
  await edit.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(edit.getByRole("checkbox", { name: future.name, exact: false })).toBeChecked();
  await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeEnabled();
  expect(retryWrites).toBe(0);
  await edit.getByRole("button", { name: "Отмена", exact: true }).click();

  // On a cold profile, a real first page alone cannot establish lost membership.
  let releasePageTwo!: () => void;
  const pageTwo = new Promise<void>(resolve => { releasePageTwo = resolve; });
  await page.route("**/api/actions/list_projects", async route => {
    if ((route.request().postDataJSON().arguments?.offset || 0) >= 500) await pageTwo;
    await route.continue();
  });
  try {
    await page.reload();
    await expect(row).toContainText("Выбранный проект — каталог временно недоступен");
    await expect(row).not.toContainText("Недоступный проект");
    await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
    await expect(edit.getByRole("checkbox", { name: "Выбранный проект Каталог временно недоступен", exact: true })).toBeChecked();
    await expect(edit.getByRole("status")).toContainText("Загружаем");
    await expect(edit.getByRole("checkbox", { name: first.items[0].name, exact: false })).toBeDisabled();
    await expect(edit.getByRole("checkbox", { name: "Выбранный проект Каталог временно недоступен", exact: true })).toBeDisabled();
    await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeDisabled();
    releasePageTwo();
    await expect(edit.getByRole("checkbox", { name: future.name, exact: false })).toBeChecked();
    await expect(edit.getByRole("checkbox", { name: future.name, exact: false })).toBeEnabled();
    await expect(edit.getByRole("checkbox")).toHaveCount(first.total + 1);
    await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeEnabled();
    await expect(row).toContainText(future.name);
    expect(retryWrites).toBe(0);
    await page.screenshot({ path: info.outputPath("token-page-two-complete.png"), fullPage: true });
  } finally {
    releasePageTwo();
    await page.unroute("**/api/actions/list_projects");
  }
  await test.info().attach("complete-catalogue", {
    body: JSON.stringify({ firstPage: first.items.length, nextOffset: first.next_offset, initialTotal: initial.total, total: first.total + 1,
      selectedId: future.id, sameBearerAllowed: (await context(future.id)).status(), retryWrites }),
    contentType: "application/json",
  });
});
