import { test, expect, expectNoOverflow } from "./fixtures";
import type { Folder, UseCase } from "../src/types";
import type { Page } from "@playwright/test";

const chip = (page: Page, label: string) =>
  page.getByRole("button", { name: `Убрать фильтр: ${label}`, exact: true });
const active = (page: Page) =>
  page.getByRole("region", { name: "Активные фильтры", exact: true });
const query = (page: Page) => new URL(page.url()).searchParams;
const resetName = "Сбросить поиск и фильтры";

test("chips remove only their value, deduplicate labels and reset pagination", async ({
  page,
  workspace,
}) => {
  const params = new URLSearchParams({
    q: "Вход",
    status: "published",
    priority: "high",
    page: "2",
    sort: "title",
    extra: "keep",
  });
  for (const tag of ["Авторизация", "Регрессия", "Авторизация"])
    params.append("tag", tag);
  for (const platform of ["iOS", "Web", "iOS"])
    params.append("platform", platform);
  await page.goto(`/p/${workspace.project.id}/cases?${params}`);
  await expect(
    active(page).getByRole("button", { name: /^Убрать фильтр:/ }),
  ).toHaveCount(7);
  const toggle = page.getByRole("button", { name: /^Фильтры/ });
  await expect(toggle).toHaveAccessibleName("Фильтры: выбрано 5");
  await expect(toggle.locator("span", { hasText: /^5$/ })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const panel = page.locator(".catalog-filters");
  await expect(panel).toHaveAttribute(
    "id",
    (await toggle.getAttribute("aria-controls"))!,
  );
  await expect(panel).toBeVisible();
  for (const value of ["Авторизация", "Регрессия", "Web", "iOS"])
    await expect(
      panel.getByRole("button", { name: `Убрать ${value}`, exact: true }),
    ).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(panel).toBeHidden();
  await expect(panel).toHaveAttribute(
    "id",
    (await toggle.getAttribute("aria-controls"))!,
  );
  await chip(page, "Тег: Авторизация").click();
  expect(query(page).getAll("tag")).toEqual(["Регрессия"]);
  expect(query(page).has("page")).toBe(false);
  expect(query(page).getAll("platform")).toEqual(["iOS", "Web", "iOS"]);
  expect(query(page).get("q")).toBe("Вход");
  expect(query(page).get("status")).toBe("published");
  expect(query(page).get("priority")).toBe("high");
  await expect(chip(page, "Тег: Авторизация")).toHaveCount(0);
  await toggle.click();
  await expect(
    panel.getByRole("button", { name: "Убрать Авторизация", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Убрать Регрессия", exact: true }),
  ).toHaveCount(1);
  await toggle.click();
  await chip(page, "Платформа: iOS").click();
  expect(query(page).getAll("platform")).toEqual(["Web"]);
  await expect(
    page.getByRole("row", { name: new RegExp(workspace.case.content.title) }),
  ).toBeVisible();
  await toggle.click();
  await expect(
    panel.getByRole("button", { name: "Убрать Авторизация", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Убрать Регрессия", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Убрать iOS", exact: true }),
  ).toHaveCount(0);
  for (const [label, key] of [
    ["Поиск: «Вход»", "q"],
    ["Статус: Опубликованные", "status"],
    ["Тег: Регрессия", "tag"],
    ["Платформа: Web", "platform"],
    ["Приоритет: Высокий", "priority"],
  ]) {
    const before = query(page);
    await chip(page, label).click();
    before.delete(key);
    expect([...query(page)]).toEqual([...before]);
  }
  await expect(active(page)).toHaveCount(0);
  await expect(
    page.getByLabel("Поиск в списке", { exact: true }),
  ).toBeFocused();
  await expect(panel.getByLabel("Приоритет", { exact: true })).toHaveValue("");
  await expect(panel).toBeVisible();
});

test("both reset actions preserve browsing context and send unfiltered API arguments", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  const folder = await workspace.apis.owner.call<Folder>("create_folder", pid, {
    name: "Область каталога",
  });
  for (const [folderId, source] of [
    ["none", "chips"],
    [folder.id, "empty"],
  ]) {
    const params = new URLSearchParams({
      folder: folderId,
      nested: "0",
      archive: "1",
      sort: "title",
      extra: "keep",
      kind: "unknown",
      q: "нет совпадений",
      status: "published",
      tag: "Авторизация",
      platform: "Web",
      priority: "high",
      page: "3",
    });
    await page.goto(`/p/${pid}/cases?${params}`);
    if (source === "empty")
      await expect(
        page.getByRole("heading", { name: "Ничего не найдено" }),
      ).toBeVisible();
    const response = page.waitForResponse((r) => {
      if (!r.url().endsWith("/api/actions/list_use_cases")) return false;
      const args = r.request().postDataJSON().arguments;
      return (
        args.search === "" &&
        args.status === "all" &&
        args.priority === null &&
        args.offset === 0
      );
    });
    const reset =
      source === "chips"
        ? active(page).getByRole("button", { name: resetName })
        : page.locator(".panel").getByRole("button", { name: resetName });
    await reset.click();
    expect([...query(page)]).toEqual([
      ["folder", folderId],
      ["nested", "0"],
      ["archive", "1"],
      ["sort", "title"],
      ["extra", "keep"],
      ["kind", "unknown"],
    ]);
    const result = await response;
    expect(result.ok()).toBeTruthy();
    expect(result.request().postDataJSON().arguments).toMatchObject({
      archived: true,
      folder_id: folderId === "none" ? null : folderId,
      without_folder: folderId === "none",
      include_subfolders: false,
      search: "",
      status: "all",
      tags: [],
      platforms: [],
      priority: null,
      offset: 0,
      sort: "title",
    });
    expect((await result.json()).items).toEqual([]);
    await expect(
      page.getByLabel("Поиск в списке", { exact: true }),
    ).toBeFocused();
    await expect(active(page)).toHaveCount(0);
  }
});

test("refresh and history restore chips, controls and real results; reset cancels pending search", async ({
  page,
  workspace,
}) => {
  const path = `/p/${workspace.project.id}/cases`;
  await page.goto(
    `${path}?q=Вход&status=published&tag=Регрессия&platform=Web&priority=high`,
  );
  const search = page.getByLabel("Поиск в списке", { exact: true });
  await expect(
    page.getByRole("row", { name: new RegExp(workspace.case.content.title) }),
  ).toBeVisible();
  await chip(page, "Поиск: «Вход»").click();
  await expect(search).toHaveValue("");
  await page.goBack();
  await expect(search).toHaveValue("Вход");
  await expect(chip(page, "Поиск: «Вход»")).toBeVisible();
  await page.reload();
  await expect(chip(page, "Приоритет: Высокий")).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(workspace.case.content.title) }),
  ).toBeVisible();
  await page.goForward();
  await expect(search).toHaveValue("");
  await expect(chip(page, "Поиск: «Вход»")).toHaveCount(0);
  const lists: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/actions/list_use_cases"))
      lists.push(r.postDataJSON().arguments);
  });
  await search.fill("запрос без результата");
  await active(page).getByRole("button", { name: resetName }).click();
  await expect(search).toHaveValue("");
  await expect(page.locator(".cases-table tbody tr")).toHaveCount(2);
  // Wait through the existing 250 ms debounce to catch a stale delayed update.
  await page.waitForTimeout(350);
  expect(query(page).has("q")).toBe(false);
  expect(lists.at(-1)?.search).toBe("");
  await expect(active(page)).toHaveCount(0);
});

test("keyboard deletion focuses the next chip, then previous chip, then search", async ({
  page,
  workspace,
  browserName,
}) => {
  await page.goto(
    `/p/${workspace.project.id}/cases?q=Вход&tag=Регрессия&platform=Web`,
  );
  const search = page.getByLabel("Поиск в списке", { exact: true });
  await search.focus();
  const firstChip = chip(page, "Поиск: «Вход»");
  // macOS WebKit uses Option+Tab to include clickable controls.
  const traversalKey =
    browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  for (let i = 0; i < 12; i++) {
    if (await firstChip.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press(traversalKey);
  }
  await expect(firstChip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chip(page, "Тег: Регрессия")).toBeFocused();
  await page.keyboard.press(traversalKey);
  await expect(chip(page, "Платформа: Web")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(chip(page, "Тег: Регрессия")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
});

test("long chip values wrap at 320 and 390 pixels in both themes", async ({
  page,
  workspace,
}) => {
  const long = "ОченьДлинноеЗначениеФильтраБезПробелов".repeat(2);
  // Synthetic data is created through the same API as the application.
  await workspace.apis.owner.call<UseCase>(
    "create_use_case",
    workspace.project.id,
    {
      content: {
        ...workspace.draft.content,
        title: long,
        tags: [long],
        platforms: [long],
      },
    },
  );
  const params = new URLSearchParams({
    q: long,
    tag: long,
    platform: long,
    priority: "high",
  });
  await page.goto(`/p/${workspace.project.id}/cases?${params}`);
  await expect(page.getByRole("row", { name: new RegExp(long) })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(chip(page, `Тег: ${long}`)).toBeVisible();
      await expectNoOverflow(page);
      const bounds = await active(page)
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((b) => ({
            width: b.clientWidth,
            content: b.scrollWidth,
            height: b.getBoundingClientRect().height,
            right: b.getBoundingClientRect().right,
          })),
        );
      for (const b of bounds) {
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.content).toBeLessThanOrEqual(b.width + 1);
        expect(b.right).toBeLessThanOrEqual(width);
      }
      await expect(
        active(page).getByRole("button", { name: resetName }),
      ).toBeVisible();
    }
  }
});

test("empty and all values have no chips; unknown values remain removable and page-only reset works", async ({
  page,
  workspace,
}) => {
  const path = `/p/${workspace.project.id}/cases`;
  await page.goto(`${path}?q=&status=all&tag=&platform=&priority=`);
  await expect(
    page.getByLabel("Поиск в списке", { exact: true }),
  ).toBeVisible();
  await expect(active(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Фильтры/ })).toHaveText(
    "Фильтры",
  );
  await page.getByRole("button", { name: /^Фильтры/ }).click();
  await expect(page.locator(".catalog-filters .picker-chip")).toHaveCount(0);
  await page.goto(`${path}?status=toString&priority=__proto__&page=2`);
  await expect(chip(page, "Статус: toString")).toBeVisible();
  await expect(chip(page, "Приоритет: __proto__")).toBeVisible();
  await chip(page, "Статус: toString").click();
  expect(query(page).get("priority")).toBe("__proto__");
  await chip(page, "Приоритет: __proto__").click();
  await expect(page.locator(".cases-table tbody tr")).toHaveCount(2);
  await page.goto(`${path}?page=5&sort=title&extra=keep`);
  await expect(active(page)).toHaveCount(0);
  await page.getByRole("button", { name: resetName, exact: true }).click();
  expect([...query(page)]).toEqual([
    ["sort", "title"],
    ["extra", "keep"],
  ]);
  await expect(page.locator(".cases-table tbody tr")).toHaveCount(2);
});
