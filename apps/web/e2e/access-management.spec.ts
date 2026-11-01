import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, expectNoOverflow } from "./fixtures";
import type { Plan, Folder } from "../src/types";

test.describe("public authentication", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("registration, login, logout and mail-disabled guidance work on the public pages", async ({
    page,
  }) => {
    const email = `ui-${randomUUID()}@example.com`,
      password = `UI-${randomUUID()}`;
    await page.goto("/auth/register");
    await page
      .getByLabel("Как вас зовут", { exact: true })
      .fill("Тест интерфейса");
    await page.getByLabel("Электронная почта", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Создать аккаунт", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Вернуться ко входу", exact: true })
      .click();
    await page.getByLabel("Электронная почта", { exact: true }).fill(email);
    await page
      .getByLabel("Пароль", { exact: true })
      .fill("deliberately-wrong-password");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Ваши проекты", exact: true }),
    ).toBeVisible();
    await expectNoOverflow(page);
    await page.goto("/profile");
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Войти", exact: true }),
    ).toBeVisible();
    await page.goto("/auth/reset");
    await expect(
      page.getByText("Отправка писем отключена.", { exact: false }),
    ).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
});

test("a project is created in a dialog and remains selected across profile and logo navigation", async ({
  page,
}) => {
  const name = "Новый проект " + randomUUID().slice(0, 8);
  await page.goto("/");
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill(name);
  await page
    .getByLabel("Ключ проекта", { exact: true })
    .fill("U" + randomUUID().replaceAll("-", "").slice(0, 8));
  await page
    .getByRole("dialog", { name: "Новый проект", exact: true })
    .getByRole("button", { name: "Создать проект", exact: true })
    .click();
  await expect(page).toHaveURL(/\/p\/[^/]+\/cases$/);
  const pid = page.url().split("/p/")[1].split("/")[0];
  await page.goto(`/p/${pid}/profile`);
  await expect(
    page.getByRole("button", { name: "Выбрать проект", exact: true }),
  ).toContainText(name);
  await page
    .getByRole("link", { name: "Юзер-кейсы выбранного проекта", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}/cases$`));
  await page
    .getByRole("button", { name: "Выбрать проект", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Выбрать проект",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expectNoOverflow(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("MCP token scopes are explicit, the one-time token is accessible, and revocation works", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  const tokenName = "UI чтение " + randomUUID().slice(0, 8);
  await page.goto(`/p/${pid}/profile?tab=mcp`);
  await page
    .getByRole("button", { name: "Создать токен", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Новый MCP-токен",
    exact: true,
  });
  await dialog.getByLabel("Название", { exact: true }).fill(tokenName);
  await dialog.getByRole("button", { name: "Чтение", exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "projects:read", exact: true }),
  ).toBeChecked();
  await expectNoOverflow(page);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await dialog
    .getByRole("button", { name: "Создать токен", exact: true })
    .click();
  const reveal = page.getByRole("dialog", {
    name: "Сохраните токен сейчас",
    exact: true,
  });
  const token = await reveal
    .getByLabel("Созданный MCP-токен", { exact: true })
    .inputValue();
  expect(token.length).toBeGreaterThan(32);
  await expect(
    reveal.getByLabel("Созданный MCP-токен", { exact: true }),
  ).toHaveAttribute("type", "password");
  await reveal
    .getByRole("button", { name: "Токен сохранён", exact: true })
    .click();
  const row = page.locator("tr").filter({ hasText: tokenName });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Отозвать", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Отозвать", exact: true }),
  ).toHaveCount(0);
  const response = await page.request.post("/api/actions/get_project_context", {
    headers: { Authorization: `Bearer ${token}` },
    data: { project_id: pid, arguments: {} },
  });
  expect(response.status()).toBe(401);
});

test("nested case folders can be renamed, moved and deleted without losing their contents", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/cases`);
  await expect(page.locator(".case-library")).toBeVisible();
  const mobileActions = page.locator(".library-mobile-actions");
  if (await mobileActions.isVisible()) {
    await mobileActions.locator("summary").click();
    await page.getByRole("button", { name: "Создать папку", exact: true }).click();
  } else await page.getByRole("button", { name: "Папка", exact: true }).click();
  await page.getByLabel("Название папки", { exact: true }).fill("Доступ");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const parent = (
    await workspace.apis.owner.call<{ items: Folder[] }>("list_folders", pid, {
      search: "Доступ",
    })
  ).items[0];
  const nested = await workspace.apis.owner.call<Folder>("create_folder", pid, {
    name: "Вход",
    parent_id: parent.id,
  });
  await page.goto(`/p/${pid}/cases?folder=${nested.id}`);
  await expect(page.locator(".case-library")).toBeVisible();
  if (await mobileActions.isVisible()) await mobileActions.locator("summary").click();
  const menu = page
    .getByRole("button", { name: "Действия с папкой «Вход»", exact: true })
    .last();
  await expect(menu).toBeVisible();
  await menu.click();
  await page
    .getByRole("menuitem", { name: "Переименовать", exact: true })
    .click();
  await page.getByLabel("Название папки", { exact: true }).fill("Сессия");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Действия с папкой «Сессия»", exact: true })
    .last()
    .click();
  await page
    .getByRole("menuitem", { name: "Переместить…", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Куда поместить папку", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Корень проекта", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Переместить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const child = (
    await workspace.apis.owner.call<{ items: Folder[] }>("list_folders", pid, {
      search: "Сессия",
    })
  ).items[0];
  expect(child.parent_id).toBeNull();
  await workspace.apis.owner.call("move_use_case", pid, {
    use_case_id: workspace.draft.id,
    expected_version: workspace.draft.version,
    folder_id: child.id,
  });
  await page
    .getByRole("button", { name: "Действия с папкой «Сессия»", exact: true })
    .last()
    .click();
  await page
    .getByRole("menuitem", { name: "Удалить папку…", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить папку", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (
      await workspace.apis.owner.call<{ folder_id: string | null }>(
        "get_use_case",
        pid,
        { use_case_id: workspace.draft.id },
      )
    ).folder_id,
  ).toBeNull();
  await expectNoOverflow(page);
});

test("an active case plan can be composed and its run preview uses the chosen data variants", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/plans`);
  await page.getByRole("button", { name: "Новый план", exact: true }).click();
  await page
    .getByLabel("Название плана", { exact: true })
    .fill("План из интерфейса");
  await page.getByLabel("Состояние", { exact: true }).selectOption("active");
  await page
    .getByLabel("Цель проверки", { exact: true })
    .fill("Проверить вход и сообщения об ошибках.");
  await page
    .getByLabel("Окружение по умолчанию", { exact: true })
    .selectOption(workspace.env.id);
  await page
    .getByRole("combobox", { name: "Добавить юзер-кейсы в план", exact: true })
    .fill("Вход");
  await page.getByRole("option", { name: /Вход в личный кабинет/ }).click();
  await page.getByRole("button", { name: /^Вход в личный кабинет/ }).click();
  await page
    .getByLabel("Варианты данных", { exact: true })
    .selectOption("explicit");
  await page
    .getByRole("checkbox", { name: "Правильные данные", exact: true })
    .check();
  await expectNoOverflow(page);
  await page
    .getByRole("button", { name: "Сохранить план", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "План из интерфейса", exact: true }),
  ).toBeVisible();
  const plans = await workspace.apis.owner.call<{ items: Plan[] }>(
    "list_case_plans",
    pid,
    { search: "План из интерфейса" },
  );
  expect(plans.items).toHaveLength(1);
  const preview = await workspace.apis.owner.call<{ count: number }>(
    "preview_case_plan",
    pid,
    { plan_id: plans.items[0].id },
  );
  expect(preview.count).toBe(1);
});
