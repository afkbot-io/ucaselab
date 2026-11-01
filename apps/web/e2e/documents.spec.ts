import AxeBuilder from "@axe-core/playwright";
import { test, expect, expectNoOverflow } from "./fixtures";
import type { UseCase, Thread } from "../src/types";

test("create, edit, publish and compare a case without silently changing its publication", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/cases`);
  await page
    .getByRole("button", { name: "Новый юзер-кейс", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Название функционала", { exact: true })
    .fill("Выход из аккаунта");
  await dialog
    .getByLabel("Цель", { exact: true })
    .fill("Пользователь завершает сессию и возвращается к форме входа.");
  const actions = dialog.getByLabel("Действие", { exact: true });
  if ((await actions.count()) === 0)
    await dialog
      .getByRole("button", { name: "Добавить шаг", exact: true })
      .click();
  await actions.first().fill("Нажмите «Выйти».");
  await dialog
    .getByLabel("Ожидаемый результат", { exact: true })
    .first()
    .fill("Открыта форма входа.");
  await dialog
    .getByRole("combobox", { name: "Теги", exact: true })
    .fill("Авторизация");
  await dialog
    .getByRole("option", { name: "Авторизация", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const cases = await workspace.apis.owner.call<{ items: UseCase[] }>(
    "list_use_cases",
    pid,
    { search: "Выход из аккаунта" },
  );
  expect(cases.items).toHaveLength(1);
  let c = await workspace.apis.owner.call<UseCase>("get_use_case", pid, {
    use_case_id: cases.items[0].id,
  });
  expect(c.content.tags).toEqual(["Авторизация"]);
  await page.goto(`/p/${pid}/cases/${c.id}`);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await page
    .getByLabel("Что вошло в эту версию", { exact: true })
    .fill("Добавлен сценарий выхода");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Опубликовать v1", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  c = await workspace.apis.owner.call<UseCase>("get_use_case", pid, {
    use_case_id: c.id,
  });
  expect(c.current_publication_id).toBeTruthy();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page
    .getByLabel("Цель", { exact: true })
    .fill("Завершить текущую сессию, сохранив данные профиля.");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "История", exact: true }).click();
  await page.getByRole("button", { name: "Сравнить", exact: true }).click();
  await expect(
    page.getByText("Завершить текущую сессию, сохранив данные профиля.", {
      exact: false,
    }),
  ).toBeVisible();
  const old = await workspace.apis.owner.call<UseCase>("get_use_case", pid, {
    use_case_id: c.id,
    published_only: true,
  });
  expect(old.content.goal).toContain("возвращается к форме входа");
});

test("comments retain their step anchor, can be edited and resolved", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  await page
    .getByRole("button", { name: "Обсудить шаг 1", exact: true })
    .click();
  await expect(
    page.getByText("Комментарий к фрагменту:", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Новое обсуждение", { exact: true })
    .fill("Уточнить начальный адрес страницы.");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.getByText("Уточнить начальный адрес страницы.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Обсуждения", exact: true })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Изменить комментарий", exact: true })
    .getByLabel("Текст", { exact: true })
    .fill("Адрес уточнён: /login.");
  await page
    .getByRole("dialog", { name: "Изменить комментарий", exact: true })
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(
    page.getByText("Адрес уточнён: /login.", { exact: true }),
  ).toBeVisible();
  const threads = await workspace.apis.owner.call<{ items: Thread[] }>(
    "list_comment_threads",
    pid,
    { use_case_id: workspace.case.id },
  );
  expect(threads.items[0].anchor?.step_key).toBe("open");
  await page.getByRole("button", { name: "Решено", exact: true }).click();
  await expect(
    page.getByText("Адрес уточнён: /login.", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Показывать завершённые", { exact: true }).check();
  await expect(
    page.getByText("Адрес уточнён: /login.", { exact: true }),
  ).toBeVisible();
});

test("appearance persists, follows the system and remains accessible", async ({
  page,
  workspace,
}) => {
  await page.goto(`/p/${workspace.project.id}/profile?tab=profile`);
  await page.getByRole("radio", { name: "Тёмная", exact: true }).check();
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
  await expect(
    page.getByText("Тема сохранена в профиле", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "Тёмная", exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoOverflow(page);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("radio", { name: "Системная", exact: true }).check();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
});

test("pages fit 320, 390, 768 and 1024 pixels", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id;
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "cases",
      `cases/${workspace.case.id}`,
      "specifications",
      `plans/${workspace.plan.id}`,
      `runs/${workspace.run.id}`,
      "proposals",
      "accounts",
      "reports",
      "settings",
      "profile?tab=profile",
    ]) {
      await page.goto(`/p/${pid}/${route}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoOverflow(page);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  await expect(
    page.getByRole("heading", { name: workspace.case.title, exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("case-mobile.png") });
});

test("long documents, labels and literal data remain readable at every viewport", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id,
    content = structuredClone(workspace.case.content);
  content.title = "Длинное название функционала " + "А".repeat(180);
  content.preconditions =
    "Перед выполнением подготовьте отдельный тестовый аккаунт и проверьте доступность стенда.\n\n".repeat(
      80,
    );
  content.tags = ["Тег " + "А".repeat(70)];
  content.variants[0].inputs = {
    long_literal: "synthetic-".repeat(140),
    flag: false,
    optional: null,
  };
  const c = await workspace.apis.owner.call<UseCase>("create_use_case", pid, {
    content,
  });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/p/${pid}/cases/${c.id}`);
    await expect(
      page.getByRole("heading", { name: content.title, exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectNoOverflow(page);
    const before = await page.locator(".case-document").boundingBox();
    await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Обсуждения", exact: true }),
    ).toBeVisible();
    expect(await page.locator(".case-document").boundingBox()).toEqual(before);
    await expectNoOverflow(page);
    await page.keyboard.press("Escape");
  }
});
