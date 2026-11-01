import { test, expect, expectNoOverflow } from "./fixtures";
import type { Folder, Thread } from "../src/types";

// Measure controls as well as the outer document: a dialog can hide an overflowing footer.
async function expectFormFits(page: import("@playwright/test").Page) {
  await expectNoOverflow(page);
  const controls = await page
    .getByRole("dialog")
    .locator("button,input,textarea,select")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length)
        .map((node) => {
          const bounds = node.getBoundingClientRect();
          return {
            label: node.getAttribute("aria-label") || node.textContent?.trim(),
            left: bounds.left,
            right: bounds.right,
          };
        }),
    );
  for (const control of controls) {
    expect(control.left, JSON.stringify(control)).toBeGreaterThanOrEqual(0);
    expect(control.right, JSON.stringify(control)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  }
}

test("document forms fit phones and tablets, remain readable and can be cancelled", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id;
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
    await page.getByRole("button", { name: "Изменить", exact: true }).click();
    await page
      .getByLabel("Название функционала", { exact: true })
      .fill("Длинное название " + "А".repeat(140));
    await page
      .getByRole("button", { name: "+ Добавить параметр", exact: true })
      .first()
      .click();
    await expectFormFits(page);
    const sizes = await page
      .getByRole("dialog")
      .getByRole("combobox")
      .evaluateAll((nodes) =>
        nodes.map((n) => parseFloat(getComputedStyle(n).fontSize)),
      );
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(width <= 760 ? 16 : 13);
    await page
      .getByRole("button", { name: "Сохранить черновик", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`editor-${width}.png`) });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть окно", exact: true })
      .click();
    for (const [route, button, title] of [
      ["specifications", "Новая спецификация", "Название спецификации"],
      ["accounts", "Новый аккаунт", "Название аккаунта"],
    ]) {
      await page.goto(`/p/${pid}/${route}`);
      await page.getByRole("button", { name: button, exact: true }).click();
      await page.getByLabel(title, { exact: true }).fill("Отменённая запись");
      await expectFormFits(page);
      await page.getByRole("button", { name: "Отмена", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const catalog = await workspace.apis.owner.call<{ total: number }>(
        route === "specifications"
          ? "list_specifications"
          : "list_test_accounts",
        pid,
        { search: "Отменённая запись" },
      );
      expect(catalog.total).toBe(0);
    }
    await page.goto(`/p/${pid}/proposals`);
    await page
      .getByRole("button", { name: "Новое предложение", exact: true })
      .click();
    await expectFormFits(page);
    await page
      .getByRole("button", { name: "Отправить на рассмотрение", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "Отмена", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`proposal-${width}.png`) });
    await page.getByRole("button", { name: "Отмена", exact: true }).click();
  }
});

test("restoring a folder does not open a picker over the submit button", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  const folder = await workspace.apis.owner.call<Folder>("create_folder", pid, {
    name: "Восстановить без препятствий",
  });
  await workspace.apis.owner.call("delete_folder", pid, {
    folder_id: folder.id,
    expected_version: folder.version,
  });
  await page.goto(`/p/${pid}/cases`);
  await expect(page.locator(".case-library")).toBeVisible();
  const mobileActions = page.locator(".library-mobile-actions");
  if (await mobileActions.isVisible()) await mobileActions.locator("summary").click();
  await page
    .getByRole("button", { name: "Удалённые папки", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Восстановить «${folder.name}»`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Восстановить папку",
    exact: true,
  });
  await expect(dialog.getByRole("combobox")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await dialog
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const restored = await workspace.apis.owner.call<Folder>("get_folder", pid, {
    folder_id: folder.id,
  });
  expect(restored.id).toBe(folder.id);
  expect(restored.archived).toBeFalsy();
  expect(restored.parent_id).toBeNull();
});

test("testers can moderate another author's comment with an audited reason", async ({
  workspace,
}) => {
  const pid = workspace.project.id;
  const thread = await workspace.apis.owner.call<Thread>(
    "create_comment_thread",
    pid,
    { use_case_id: workspace.case.id, body: "Дублирующий вопрос от коллеги" },
  );
  const { page } = await workspace.asRole("tester");
  await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
  await page
    .getByRole("button", { name: "Скрыть комментарий", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Скрыть комментарий",
    exact: true,
  });
  await dialog
    .getByLabel("Причина скрытия", { exact: true })
    .fill("Дубликат уже решённого вопроса");
  await dialog
    .getByRole("button", { name: "Скрыть комментарий", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Комментарий удалён", { exact: true }),
  ).toBeVisible();
  const updated = await workspace.apis.tester.call<Thread>(
    "get_comment_thread",
    pid,
    { thread_id: thread.id },
  );
  expect(updated.comments[0].deleted).toBeTruthy();
  const developer = await workspace.asRole("developer");
  await developer.page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  await developer.page
    .getByRole("button", { name: "Обсуждения", exact: true })
    .click();
  await expect(
    developer.page.getByRole("button", {
      name: "Скрыть комментарий",
      exact: true,
    }),
  ).toHaveCount(0);
});

test.describe("authentication response isolation", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("a delayed registration response cannot replace the login form", async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/register", async (route) => {
      await gate;
      await route.fulfill({ json: { message: "Регистрация завершена" } });
    });
    await page.goto("/auth/register");
    await page
      .getByLabel("Как вас зовут", { exact: true })
      .fill("Тест задержки");
    await page
      .getByLabel("Электронная почта", { exact: true })
      .fill("delayed@example.invalid");
    await page
      .getByLabel("Пароль", { exact: true })
      .fill("synthetic-delay-password");
    const pending = page.waitForRequest("**/api/auth/register");
    await page
      .getByRole("button", { name: "Создать аккаунт", exact: true })
      .click();
    await pending;
    await page.getByRole("link", { name: "Войти", exact: true }).click();
    const completed = page.waitForResponse("**/api/auth/register");
    release();
    await completed;
    await expect(
      page.getByRole("button", { name: "Войти", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Пароль", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Регистрация завершена", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test("project switching never exposes actions from the previous project while loading", async ({
  page,
  workspace,
}) => {
  const project = await workspace.apis.owner.call<
    import("../src/types").Project
  >("create_project", null, {
    name: "Проверка переключения " + workspace.project.id,
    key:
      "S" + workspace.project.id.replaceAll("-", "").slice(0, 9).toUpperCase(),
  });
  await page.goto(`/p/${workspace.project.id}/cases`);
  // The loading shell has its own Topbar, replaced when context is ready.
  // Begin the switch from the mounted project UI, not that transient shell.
  await expect(page.getByRole("heading", { name: "Юзер-кейсы", exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/actions/get_project_context", async (route) => {
    if (route.request().postDataJSON().project_id === project.id) await gate;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Выбрать проект", exact: true })
    .click();
  await page.getByLabel("Поиск проекта", { exact: true }).fill(project.name);
  await page
    .getByRole("dialog")
    .getByRole("link", { name: new RegExp(project.name) })
    .click();
  await expect(page).toHaveURL(`/p/${project.id}/cases`);
  try {
    await expect(
      page.getByRole("navigation", { name: "Основная навигация" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Новый юзер-кейс", exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "Выбрать проект", exact: true }),
  ).toContainText(project.name);
  await expect(page.locator(".topbar .avatar")).toHaveAttribute(
    "href",
    `/p/${project.id}/profile`,
  );
});

test("built fonts load with the production content security policy", async ({
  page,
  workspace,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const response = await page.goto(`/p/${workspace.project.id}/cases`);
  expect(response?.headers()["content-security-policy"]).toContain(
    "font-src 'self'",
  );
  await expect(
    page.getByRole("heading", { name: "Юзер-кейсы", exact: true }),
  ).toBeVisible();
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((font) => font.family.includes("Manrope"))
      .map((font) => font.status);
  });
  expect(fonts).toContain("loaded");
  expect(fonts).not.toContain("error");
  expect(errors).toEqual([]);
});
