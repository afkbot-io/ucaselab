import { test, expect, navigateSection } from "./fixtures";
import type { Attention } from "../src/attention";

test("proposal badges keep pending work after reading the event, and disappear after QA review", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  const developer = await workspace.asRole("developer");
  await developer.page.goto(`/p/${pid}/proposals`);
  await developer.page
    .getByRole("button", { name: "Новое предложение", exact: true })
    .click();
  await developer.page
    .getByLabel("Название предложения", { exact: true })
    .fill("Добавить проверку выхода");
  await developer.page
    .getByRole("dialog")
    .locator("textarea")
    .first()
    .fill("Добавить сценарий выхода из аккаунта и очистки сессии.");
  await developer.page
    .getByRole("button", { name: "Отправить на рассмотрение", exact: true })
    .click();
  await expect(developer.page.getByRole("dialog")).toHaveCount(0);
  await page.goto(`/p/${pid}/cases`);
  await expect(
    page.getByRole("link", {
      name: "Уведомления: 1 непрочитанных",
      exact: true,
    }),
  ).toBeVisible();
  if (await page.getByRole("button", { name: "Меню", exact: true }).isVisible())
    await page.getByRole("button", { name: "Меню", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /^Предложения: 1 требуют внимания/ }),
  ).toBeVisible();
  if (await page.getByRole("dialog", { name: "Навигация проекта" }).isVisible())
    await page.keyboard.press("Escape");
  await workspace.apis.owner.call("mark_notifications_read", pid, {
    all_read: true,
  });
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  if (await page.getByRole("button", { name: "Меню", exact: true }).isVisible())
    await page.getByRole("button", { name: "Меню", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /^Предложения: 1 требуют внимания/ }),
  ).toBeVisible();
  if (await page.getByRole("dialog", { name: "Навигация проекта" }).isVisible())
    await page.keyboard.press("Escape");
  const proposals = await workspace.apis.owner.call<{
    items: { id: string; version: number }[];
  }>("list_proposals", pid);
  await workspace.apis.owner.call("accept_proposal", pid, {
    proposal_id: proposals.items[0].id,
    expected_version: proposals.items[0].version,
    reason: "Принято для подготовки сценария.",
  });
  const attention = await workspace.apis.owner.call<Attention>(
    "get_project_attention",
    pid,
  );
  expect(attention.pending_proposals).toBe(0);
  expect(attention.sections.proposals).toBe(0);
  expect(
    (await developer.api.call<Attention>("get_project_attention", pid)).sections
      .proposals,
  ).toBe(1);
});

for (const role of ["developer", "tester", "manager"] as const)
  test(`${role}: interface actions match server permissions`, async ({
    workspace,
  }) => {
    const { page, api } = await workspace.asRole(role);
    const pid = workspace.project.id;
    await page.goto(`/p/${pid}/cases`);
    await expect(
      page.getByRole("heading", { name: "Юзер-кейсы", exact: true }),
    ).toBeVisible();
    if (role === "developer") {
      await expect(
        page.getByRole("button", { name: "Новый юзер-кейс", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(workspace.draft.title, { exact: true }),
      ).toHaveCount(0);
      expect(
        (
          await api.raw("create_use_case", pid, {
            content: { title: "Forbidden" },
          })
        ).status(),
      ).toBe(403);
      await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
      await expect(
        page.getByRole("button", { name: "Изменить", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Проверить", exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByRole("button", { name: "Новый юзер-кейс", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(workspace.draft.title, { exact: true }),
      ).toBeVisible();
    }
    await page.goto(`/p/${pid}/settings`);
    await page.getByRole("tab", { name: "Команда", exact: true }).click();
    if (role === "manager") {
      await page.getByRole("button", { name: /Пригласить/ }).click();
      await expect(
        page.getByRole("option", { name: "Менеджер", exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByRole("button", { name: /Пригласить/ }),
      ).toHaveCount(0);
      expect(
        (
          await api.raw("invite_project_member", pid, {
            email: "nobody@example.invalid",
            role: "tester",
          })
        ).status(),
      ).toBe(403);
    }
  });

test("a non-member cannot open the project or read its data", async ({
  workspace,
}) => {
  const { page, api } = await workspace.asRole("outsider");
  expect(
    (await api.raw("get_project_context", workspace.project.id)).status(),
  ).toBe(404);
  await page.goto(`/p/${workspace.project.id}/cases`);
  await expect(
    page.getByText("Проект не найден", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Новый юзер-кейс" }),
  ).toHaveCount(0);
});
