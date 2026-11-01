import { test, expect, expectNoOverflow } from "./fixtures";
import type { Thread } from "../src/types";

const panelName = { name: "Обсуждения", exact: true } as const;

test("discussion drawer permits background pointer, keyboard and independent scrolling", async ({
  page,
  workspace,
}, info) => {
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  await page.getByRole("button", panelName).click();
  const panel = page.getByRole("dialog", panelName);
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((e) => e.matches(":modal"))).toBe(false);
  const input = panel.getByLabel("Новое обсуждение", { exact: true });
  await input.fill("Черновик обсуждения");
  if (info.project.name !== "mobile-chromium") {
    const tab = page.getByRole("tab", { name: "История", exact: true });
    await tab.click();
    await expect(panel).toBeVisible();
    const scenario = page.getByRole("tab", { name: "Сценарий", exact: true });
    await scenario.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".case-document")).toBeVisible();
    const background = page.locator(".workspace");
    const before = await background.evaluate((e) => e.scrollTop);
    await page.mouse.move(500, 600);
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => background.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(before);
    const top = await panel.evaluate((e) => e.getBoundingClientRect().top);
    expect(top).toBe(80);
    await background.evaluate((e) => {
      e.scrollTop = 0;
    });
  }
  await input.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", panelName)).toBeFocused();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Черновик обсуждения");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoOverflow(page);
    await page.screenshot({ path: info.outputPath(`discussion-${theme}.png`) });
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await expectNoOverflow(page);
  await panel
    .getByRole("button", { name: "Отправить", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    panel.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeInViewport();
  await panel
    .getByRole("button", { name: "Закрыть окно", exact: true })
    .click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Черновик обсуждения");
});

test("new, reply and edit drafts survive close, errors and isolated targets", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  const thread = await workspace.apis.owner.call<Thread>(
    "create_comment_thread",
    pid,
    {
      use_case_id: workspace.case.id,
      body: "Первое сообщение",
    },
  );
  await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  await page.getByRole("button", panelName).click();
  const panel = page.getByRole("dialog", panelName);
  const input = panel.getByLabel("Новое обсуждение", { exact: true });
  const originalThread = panel.locator("#thread-" + thread.id);
  const reply = originalThread.getByLabel("Ответить", { exact: true });
  await input.fill("Новое сообщение");
  await reply.fill("Незаконченный ответ");
  await panel
    .getByRole("button", { name: "Закрыть окно", exact: true })
    .click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Новое сообщение");
  await expect(reply).toHaveValue("Незаконченный ответ");
  await page.route("**/api/actions/create_comment_thread", (route) =>
    route.fulfill({ status: 503, json: { detail: "Синтетическая ошибка" } }),
  );
  await panel.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    panel.getByText("Синтетическая ошибка", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("Новое сообщение");
  await page.unroute("**/api/actions/create_comment_thread");
  await panel.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(reply).toHaveValue("Незаконченный ответ");
  await page.route("**/api/actions/create_comment", (route) =>
    route.fulfill({ status: 503, json: { detail: "Ошибка ответа" } }),
  );
  await originalThread
    .getByRole("button", { name: "Отправить ответ", exact: true })
    .click();
  await expect(
    originalThread.getByText("Ошибка ответа", { exact: true }),
  ).toBeVisible();
  await expect(reply).toHaveValue("Незаконченный ответ");
  await page.unroute("**/api/actions/create_comment");
  await originalThread
    .getByRole("button", { name: "Отправить ответ", exact: true })
    .click();
  await expect(reply.first()).toHaveValue("");
  await panel
    .getByRole("button", { name: "Изменить", exact: true })
    .first()
    .click();
  const edit = page.getByRole("dialog", {
    name: "Изменить комментарий",
    exact: true,
  });
  expect(await edit.evaluate((e) => e.matches(":modal"))).toBe(true);
  await edit.getByLabel("Текст", { exact: true }).fill("Несохранённая правка");
  await page.route("**/api/actions/update_comment", (route) =>
    route.fulfill({ status: 503, json: { detail: "Ошибка правки" } }),
  );
  await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(edit.getByText("Ошибка правки", { exact: true })).toBeVisible();
  await expect(edit.getByLabel("Текст", { exact: true })).toHaveValue(
    "Несохранённая правка",
  );
  await page.unroute("**/api/actions/update_comment");

  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", panelName).click();
  await panel
    .getByRole("button", { name: "Изменить", exact: true })
    .first()
    .click();
  await expect(edit.getByLabel("Текст", { exact: true })).toHaveValue(
    "Несохранённая правка",
  );
  await page.keyboard.press("Escape");
  await input.fill("Черновик первого объекта");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "К юзер-кейсам", exact: true }).click();
  await page
    .getByRole("link", {
      name: "Открыть " + workspace.draft.title,
      exact: true,
    })
    .click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("");
  await input.fill("Черновик второго объекта");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "К юзер-кейсам", exact: true }).click();
  await page
    .getByRole("link", { name: "Открыть " + workspace.case.title, exact: true })
    .click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Черновик первого объекта");
});

test("specification discussion stays within its modal context and Escape closes one layer", async ({
  page,
  workspace,
}) => {
  await page.goto(
    `/p/${workspace.project.id}/specifications?open=${workspace.spec.id}`,
  );
  const spec = page.getByRole("dialog", {
    name: workspace.spec.title,
    exact: true,
  });
  await spec.getByRole("button", panelName).click();
  const panel = page.getByRole("dialog", panelName);
  expect(await panel.evaluate((e) => e.matches(":modal"))).toBe(false);
  await panel
    .getByLabel("Новое обсуждение", { exact: true })
    .fill("Уточнение требования");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(spec).toBeVisible();
  await expect(spec.getByRole("button", panelName)).toBeFocused();
  await spec.getByRole("button", panelName).click();
  await expect(
    panel.getByLabel("Новое обсуждение", { exact: true }),
  ).toHaveValue("Уточнение требования");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(spec).toHaveCount(0);
});

test("discussion drafts are private to the authenticated user across in-app logout and login", async ({
  page,
  workspace,
}) => {
  // Create a private session so logout does not revoke the shared fixture session.
  await page.goto("/auth/login");
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill(workspace.identities.owner.email);
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(workspace.identities.owner.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваши проекты", exact: true }),
  ).toBeVisible();
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  const panel = page.getByRole("dialog", panelName);
  const input = panel.getByLabel("Новое обсуждение", { exact: true });
  await page.getByRole("button", panelName).click();
  await input.fill("Личный черновик руководителя");
  await page.keyboard.press("Escape");
  await page.locator(".topbar a.avatar").click();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill(workspace.identities.tester.email);
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(workspace.identities.tester.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("heading", {
        name: workspace.project.name,
        exact: true,
      }),
    })
    .getByRole("link", { name: "Открыть", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Открыть " + workspace.case.title, exact: true })
    .click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("");
  await input.fill("Личный черновик тестировщика");
  await page.keyboard.press("Escape");
  await page.locator(".topbar a.avatar").click();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill(workspace.identities.owner.email);
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(workspace.identities.owner.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("heading", {
        name: workspace.project.name,
        exact: true,
      }),
    })
    .getByRole("link", { name: "Открыть", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Открыть " + workspace.case.title, exact: true })
    .click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Личный черновик руководителя");
});

test("long discussions scroll independently of the document", async ({
  page,
  workspace,
}) => {
  await workspace.apis.owner.call(
    "create_comment_thread",
    workspace.project.id,
    {
      use_case_id: workspace.case.id,
      body: "Длинное обсуждение\n".repeat(40),
    },
  );
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  await page.getByRole("button", panelName).click();
  const panel = page.getByRole("dialog", panelName);
  await expect(panel.locator(".comment-body")).toBeVisible();
  const scroll = panel.locator(".comments-panel");
  const background = page.locator(".workspace");
  const before = await background.evaluate((e) => e.scrollTop);
  await scroll.hover();
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => scroll.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  expect(await background.evaluate((e) => e.scrollTop)).toBe(before);
  await panel
    .getByLabel("Новое обсуждение", { exact: true })
    .fill("Ответ после чтения");
  await expectNoOverflow(page);
});
