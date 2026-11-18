import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { test, expect, expectNoOverflow } from "./fixtures";
import type { Project } from "../src/types";
import type { Locator } from "@playwright/test";

async function clearSelectedProjects(dialog: Locator) {
  const selected = dialog.getByRole("group", { name: "Доступ к проектам", exact: true })
    .getByRole("checkbox", { checked: true });
  const count = await selected.count();
  for (let index = 0; index < count; index++) await selected.first().uncheck();
  await expect(selected).toHaveCount(0);
  return count;
}

test("token access edits preserve the bearer, refresh projects and handle errors", async ({ page, workspace, api }) => {
  test.setTimeout(120_000);
  const name = "Динамический агент " + randomUUID().slice(0, 8);
  await page.goto(`/p/${workspace.project.id}/cases`);
  await page.goto("/profile?tab=mcp");
  await page.getByRole("button", { name: "Создать токен", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Новый MCP-токен", exact: true });
  await dialog.getByLabel("Название", { exact: true }).fill(name);
  await expect(dialog.getByRole("radio", { name: "Выбранные проекты", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "Все проекты", exact: true }).check();
  await dialog.getByRole("button", { name: "Создать токен", exact: true }).click();
  const reveal = page.getByRole("dialog", { name: "Сохраните токен сейчас", exact: true });
  const raw = await reveal.getByLabel("Созданный MCP-токен", { exact: true }).inputValue();
  await reveal.getByRole("button", { name: "Токен сохранён", exact: true }).click();
  const row = page.locator("tr").filter({ hasText: name });
  await expect(row).toContainText("Все проекты");
  const future = await api.call<Project>("create_project", null, { name: "Новый проект " + randomUUID().slice(0, 8), key: "N"+randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase() });
  const bearerContext = () => page.request.post("/api/actions/get_project_context", {
    headers: { Authorization: `Bearer ${raw}` }, data: { project_id: future.id, arguments: {} },
  });
  expect((await bearerContext()).status()).toBe(200);
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Изменить доступ", exact: true });
  await expect(dialog.getByRole("radio", { name: "Все проекты", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "Выбранные проекты", exact: true }).check();
  await expect(dialog.getByRole("checkbox", { name: future.name, exact: false })).toBeVisible();
  // Work scales with selected projects, not the entire accumulated catalogue.
  const catalogueSize = await dialog.getByRole("checkbox").count();
  const clearingActions = [await clearSelectedProjects(dialog)];
  await dialog.getByRole("checkbox", { name: workspace.project.name, exact: false }).check();
  await page.route("**/api/tokens/*", route => route.fulfill({ status: 500, json: { detail: { message: "Синтетическая ошибка сохранения", code: "TEST_ERROR" } } }));
  await dialog.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Синтетическая ошибка");
  await expect(dialog.getByRole("checkbox", { name: workspace.project.name, exact: false })).toBeChecked();
  await page.unroute("**/api/tokens/*");
  // A second browser changes the same settings while the editor remains open.
  const me = await (await page.request.get("/api/auth/me")).json();
  const tokens = await (await page.request.get("/api/tokens")).json();
  const current = tokens.items.find((item: { name: string }) => item.name === name);
  const concurrent = await page.request.patch("/api/tokens/" + current.id, {
    headers: { "X-CSRF-Token": me.csrf },
    data: { project_access: "all", project_ids: [], expected_version: current.access_version },
  });
  expect(concurrent.ok()).toBeTruthy();
  await dialog.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Доступ уже изменён");
  await expect(dialog.getByRole("checkbox", { name: workspace.project.name, exact: false })).toBeChecked();
  let conflictReloadWrites = 0;
  const observeReload = (request: import("@playwright/test").Request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/tokens/")) conflictReloadWrites++;
  };
  page.on("request", observeReload);
  await dialog.getByRole("button", { name: "Загрузить актуальный доступ", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Все проекты", exact: true })).toBeChecked();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "Все проекты", exact: true })).toBeFocused();
  expect(conflictReloadWrites).toBe(0);
  page.off("request", observeReload);
  await dialog.getByRole("radio", { name: "Выбранные проекты", exact: true }).check();
  clearingActions.push(await clearSelectedProjects(dialog));
  await dialog.getByRole("checkbox", { name: workspace.project.name, exact: false }).check();
  await dialog.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await bearerContext()).status()).toBe(404);
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: workspace.project.name, exact: false })).toBeChecked();
  await dialog.getByRole("radio", { name: "Все проекты", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Изменить доступ", exact: true })).toBeFocused();
  expect((await bearerContext()).status()).toBe(404);
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Выбранные проекты", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "Все проекты", exact: true }).check();
  await dialog.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await bearerContext()).status()).toBe(200);
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await dialog.getByRole("radio", { name: "Выбранные проекты", exact: true }).check();
  clearingActions.push(await clearSelectedProjects(dialog));
  await dialog.getByRole("checkbox", { name: future.name, exact: false }).check();
  await dialog.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await expect(row).toContainText(future.name);
  await expect(row).not.toContainText("Недоступный проект");
  expect((await bearerContext()).status()).toBe(200);
  expect(clearingActions).toEqual([0, 0, 0]);
  await test.info().attach("selection-clearing-actions", {
    body: JSON.stringify({ catalogueSize, clearingActions, total: clearingActions.reduce((a, b) => a + b, 0) }),
    contentType: "application/json",
  });
});

test("access forms fit narrow screens and themes with keyboard and accessible labels", async ({ page, workspace, api }, info) => {
  test.setTimeout(120_000);
  await page.goto(`/p/${workspace.project.id}/cases`);
  await page.goto("/profile?tab=mcp");
  const name = "Визуальная проверка " + randomUUID().slice(0, 8);
  await api.call("update_project", workspace.project.id, {
    name: "ДлинноеИмяПроекта".repeat(9), expected_version: workspace.project.version,
  });
  await page.getByRole("button", { name: "Создать токен", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Новый MCP-токен", exact: true });
  await create.getByLabel("Название", { exact: true }).fill(name);
  await create.getByRole("radio", { name: "Все проекты", exact: true }).check();
  await create.getByRole("button", { name: "Создать токен", exact: true }).click();
  await page.getByRole("button", { name: "Токен сохранён", exact: true }).click();
  for (const theme of ["light", "dark"] as const) {
    await api.profile({ theme });
    await page.reload();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.getByRole("button", { name: "Создать токен", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Новый MCP-токен", exact: true });
      await dialog.getByRole("radio", { name: "Все проекты", exact: true }).check();
      await expectNoOverflow(page);
      const box = await dialog.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width).toBeTruthy();
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`token-create-${theme}-${width}.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      const row = page.locator("tr").filter({ hasText: name });
      await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Изменить доступ", exact: true });
      await edit.getByRole("radio", { name: "Выбранные проекты", exact: true }).check();
      await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeEnabled();
      await edit.getByRole("button", { name: "Сохранить доступ", exact: true }).hover();
      await expectNoOverflow(page);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`token-edit-${theme}-${width}.png`), fullPage: true });
      await edit.getByRole("button", { name: "Отмена", exact: true }).click();
      await expect(edit).toHaveCount(0);
      if (width <= 390) {
        const list = page.getByRole("region", { name: "Персональные токены", exact: true });
        await list.evaluate(element => { element.scrollLeft = 0; });
        await expectNoOverflow(page);
        const firstCell = await row.getByRole("cell").first().boundingBox();
        expect(firstCell && firstCell.width >= 150).toBeTruthy();
        await page.screenshot({ path: info.outputPath(`token-list-${theme}-${width}.png`), fullPage: true });
        await list.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        const editButton = row.getByRole("button", { name: "Изменить доступ", exact: true });
        await editButton.focus();
        await page.keyboard.press("Enter");
        await expect(edit).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(editButton).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(row.getByRole("button", { name: "Отозвать", exact: true })).toBeFocused();
        await page.screenshot({ path: info.outputPath(`token-list-actions-${theme}-${width}.png`), fullPage: true });
        if (info.project.use.hasTouch) {
          await editButton.tap();
          await expect(edit).toBeVisible();
          await edit.getByRole("button", { name: "Отмена", exact: true }).tap();
          await expect(edit).toHaveCount(0);
        }
      }
    }
  }
});

test("empty catalogue and catalogue retry explain access without losing selections", async ({ page, workspace }, info) => {
  await page.goto(`/p/${workspace.project.id}/cases`);
  await page.goto("/profile?tab=mcp");
  await page.route("**/api/actions/list_projects", route => route.fulfill({
    json: { items: [], total: 0, next_offset: null },
  }));
  await page.getByRole("button", { name: "Создать токен", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Новый MCP-токен", exact: true });
  await expect(create).toContainText("Нет доступных активных проектов");
  // A stale session selection is still explicit; no new selection is inferred as all.
  const access = create.getByRole("group", { name: "Доступ к проектам", exact: true });
  for (const checkbox of await access.getByRole("checkbox").all()) await checkbox.uncheck();
  await expect(create.getByRole("button", { name: "Создать токен", exact: true })).toBeDisabled();
  await create.getByRole("radio", { name: "Все проекты", exact: true }).check();
  const name = "Пустой каталог " + randomUUID().slice(0, 8);
  await create.getByLabel("Название", { exact: true }).fill(name);
  await create.getByRole("button", { name: "Создать токен", exact: true }).click();
  await page.getByRole("button", { name: "Токен сохранён", exact: true }).click();
  await page.unroute("**/api/actions/list_projects");
  const row = page.locator("tr").filter({ hasText: name });
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Изменить доступ", exact: true });
  await edit.getByRole("radio", { name: "Выбранные проекты", exact: true }).check();
  await expect(edit).toContainText("токен не получит доступ ни к одному проекту");
  await edit.getByRole("checkbox", { name: workspace.project.name, exact: false }).check();
  await edit.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await page.route("**/api/actions/list_projects", route => route.fulfill({ status: 500,
    json: { detail: { code: "TEST_ERROR", message: "Синтетическая ошибка каталога" } },
  }));
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await expect(edit).toContainText("Синтетическая ошибка каталога");
  await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeDisabled();
  await expect(edit.getByRole("checkbox", { name: workspace.project.name, exact: false })).toBeChecked();
  await page.screenshot({ path: info.outputPath("token-catalogue-error.png"), fullPage: true });
  let retrySaves = 0;
  page.on("request", request => {
    if (request.method() === "PATCH" && request.url().includes("/api/tokens/")) retrySaves++;
  });
  await page.unroute("**/api/actions/list_projects");
  await edit.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(edit.getByRole("checkbox", { name: workspace.project.name, exact: false })).toBeChecked();
  await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeEnabled();
  expect(retrySaves).toBe(0);
  await edit.getByRole("button", { name: "Отмена", exact: true }).click();

  // A successful empty response confirms unavailability. A failed request cannot do so.
  await page.route("**/api/actions/list_projects", route => route.fulfill({
    json: { items: [], total: 0, next_offset: null },
  }));
  await page.reload();
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await expect(edit.getByRole("checkbox", { name: "Недоступный проект", exact: false })).toBeChecked();
  await edit.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.unroute("**/api/actions/list_projects");
  await page.route("**/api/actions/list_projects", route => route.fulfill({ status: 500,
    json: { detail: { code: "TEST_ERROR", message: "Синтетическая ошибка каталога" } },
  }));
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await expect(edit).toContainText("Синтетическая ошибка каталога");
  await expect(edit.getByRole("checkbox", { name: "Выбранный проект Каталог временно недоступен", exact: true })).toBeChecked();
  await expect(edit).not.toContainText("Недоступный проект");
  await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("token-unknown-catalogue-error.png"), fullPage: true });
  await page.unroute("**/api/actions/list_projects");
  await edit.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(edit.getByRole("checkbox", { name: workspace.project.name, exact: false })).toBeChecked();
  await expect(edit.getByRole("button", { name: "Сохранить доступ", exact: true })).toBeEnabled();
  expect(retrySaves).toBe(0);
});


test("project checkbox accepts native pointer and keyboard without losing the bearer selection", async ({ page, workspace, api }, info) => {
  // Make the scroll precondition independent of other tests and their catalogues.
  for (let index = 0; index < 12; index++) {
    await api.call("create_project", null, {
      name: `А прокрутка ${randomUUID().slice(0, 8)}`, key: "S" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
    });
  }
  const other = await api.call<Project>("create_project", null, {
    name: "Другой проект " + randomUUID().slice(0, 8), key: "K" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
  });
  const me = await (await page.request.get("/api/auth/me")).json();
  const name = "Указатель и клавиатура " + randomUUID().slice(0, 8);
  const issued = await page.request.post("/api/tokens", {
    headers: { "X-CSRF-Token": me.csrf },
    data: { name, project_access: "all", scopes: ["projects:read"] },
  });
  expect(issued.ok()).toBeTruthy();
  const token = await issued.json();
  const context = (projectId: string) => page.request.post("/api/actions/get_project_context", {
    headers: { Authorization: "Bearer " + token.token }, data: { project_id: projectId, arguments: {} },
  });
  expect((await context(other.id)).status()).toBe(200);
  await page.goto(`/p/${workspace.project.id}/profile?tab=mcp`);
  const row = page.locator("tr").filter({ hasText: name });
  await row.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Изменить доступ", exact: true });
  await dialog.getByRole("radio", { name: "Выбранные проекты", exact: true }).check();
  const checkbox = dialog.getByRole("checkbox", { name: workspace.project.name, exact: false });
  await expect(checkbox).not.toBeInViewport();
  // Capture the browser's actual hit targets. In the WebKit regression, native
  // scrolling sent down to this input but up to another row, so no click fired.
  const pointerHits = await checkbox.evaluateHandle((input) => {
    const hits: { type: string; targetMatches: boolean; inside: boolean }[] = [];
    for (const type of ["pointerdown", "pointerup"]) {
      document.addEventListener(type, (event) => {
        const pointer = event as PointerEvent;
        const rect = input.getBoundingClientRect();
        hits.push({ type, targetMatches: event.target === input,
          inside: pointer.clientX >= rect.left && pointer.clientX < rect.right
            && pointer.clientY >= rect.top && pointer.clientY < rect.bottom });
      }, { capture: true, once: true });
    }
    return hits;
  });
  // Ordinary pointer action from an offscreen row; never force or mutate checked via JS.
  await checkbox.click();
  const hits = await pointerHits.jsonValue();
  await pointerHits.dispose();
  await info.attach("native-pointer-hit-targets", { body: JSON.stringify(hits), contentType: "application/json" });
  expect(hits).toEqual([
    { type: "pointerdown", targetMatches: true, inside: true },
    { type: "pointerup", targetMatches: true, inside: true },
  ]);
  await expect(checkbox).toBeChecked();
  if (info.project.use.hasTouch) {
    await checkbox.tap();
    await expect(checkbox).not.toBeChecked();
    await checkbox.tap();
    await expect(checkbox).toBeChecked();
  }
  await expect(checkbox).toBeFocused();
  const documentHasFocus = await page.evaluate(() => document.hasFocus());
  await info.attach("native-keyboard-focus", { body: JSON.stringify({ documentHasFocus }), contentType: "application/json" });
  expect(documentHasFocus).toBe(true);
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await page.screenshot({ path: info.outputPath("token-native-pointer-keyboard.png"), fullPage: true });
  // Hold a real save response to prove pending pointer/keyboard interaction is
  // blocked and its live status stays accessible. No response is fabricated.
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  const savePath = "**/api/tokens/" + token.id;
  await page.route(savePath, async route => {
    const response = await route.fetch();
    await saveGate;
    await route.fulfill({ response });
  });
  const save = dialog.getByRole("button", { name: "Сохранить доступ", exact: true });
  try {
    await save.click();
    await expect(checkbox).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole("status")).toContainText("Сохраняем");
    const box = await checkbox.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
  } finally {
    releaseSave();
  }
  await expect(dialog).toHaveCount(0);
  await page.unroute(savePath);
  const listed = await (await page.request.get("/api/tokens")).json();
  const saved = listed.items.find((item: { id: string }) => item.id === token.id);
  expect(saved.project_ids).toEqual([workspace.project.id]);
  expect(saved.expires_at).toBe(token.expires_at);
  expect((await context(workspace.project.id)).status()).toBe(200);
  expect((await context(other.id)).status()).toBe(404);
  if (info.project.use.hasTouch) {
    await page.setViewportSize({ width: 390, height: 844 });
    await row.getByRole("button", { name: "Отозвать", exact: true }).tap();
    await expect(row).toContainText("Отозван");
    expect((await context(workspace.project.id)).status()).toBe(401);
    await page.screenshot({ path: info.outputPath("token-touch-revoked.png"), fullPage: true });
  }
});
