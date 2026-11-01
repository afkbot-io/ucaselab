import AxeBuilder from "@axe-core/playwright";
import { test, expect, expectNoOverflow, navigateSection } from "./fixtures";

test("all project sections load, remain accessible and fit their viewport", async ({
  page,
  workspace,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/p/${workspace.project.id}/cases`);
  for (const section of [
    "Юзер-кейсы",
    "Спецификации",
    "Тестовые аккаунты",
    "Кейс-планы",
    "Проверки",
    "Предложения",
    "Отчёты",
    "Настройки проекта",
    "MCP и навыки",
  ]) {
    await navigateSection(page, section);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.getByText("Не удалось загрузить", { exact: false }),
    ).toHaveCount(0);
    await expectNoOverflow(page);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      scan.violations,
      `${section}: ${JSON.stringify(scan.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))}`,
    ).toEqual([]);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sections.png") });
});

test("case reading stays fixed while discussions open and close", async ({
  page,
  workspace,
}) => {
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  await expect(
    page.getByRole("heading", { name: workspace.case.title, exact: true }),
  ).toBeVisible();
  const before = await page.locator(".case-document").boundingBox();
  await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Обсуждения", exact: true }),
  ).toBeVisible();
  expect(await page.locator(".case-document").boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Обсуждения", exact: true }),
  ).toBeFocused();
  await expectNoOverflow(page);
});

test("mobile navigation shows changed-access attention and restores focus in every browser", async ({
  workspace,
}) => {
  const pid = workspace.project.id;
  const members = await workspace.apis.owner.call<{
    items: { id: string; user_id: string }[];
  }>("list_project_members", pid);
  const member = members.items.find(
    (m) => m.user_id === workspace.identities.tester.id,
  )!;
  await workspace.apis.owner.call("update_project_member", pid, {
    member_id: member.id,
    role: "tester",
    can_read_secrets: true,
  });
  const { page } = await workspace.asRole("tester");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${pid}/cases`);
  await expect(
    page.getByRole("heading", { name: "Юзер-кейсы", exact: true }),
  ).toBeVisible();
  const trigger = page.getByRole("button", { name: "Меню", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Навигация проекта",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("link", {
      name: "Настройки проекта: 1 требуют внимания",
      exact: true,
    }),
  ).toBeVisible();
  await expectNoOverflow(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});


test("advanced filter counter stays readable and accessible across themes and widths", async ({
  page,
  workspace,
}, testInfo) => {
  const path = `/p/${workspace.project.id}/cases`;
  const toggle = page.getByRole("button", { name: /^Фильтры/ });
  await page.goto(`${path}?q=Вход&status=published`);
  await expect(toggle).toHaveAccessibleName("Фильтры: выбрано 0");
  await expect(toggle).toHaveText("Фильтры");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await page.goto(`${path}?tag=Регрессия&tag=Регрессия&platform=Web&priority=high`);
  await expect(toggle).toHaveAccessibleName("Фильтры: выбрано 3");
  await page.getByRole("button", { name: "Убрать фильтр: Платформа: Web", exact: true }).click();
  await expect(toggle).toHaveAccessibleName("Фильтры: выбрано 2");
  await page.getByRole("button", { name: "Убрать фильтр: Тег: Регрессия", exact: true }).click();
  await expect(toggle).toHaveAccessibleName("Фильтры: выбрано 1");
  await page.getByRole("button", { name: "Сбросить поиск и фильтры", exact: true }).click();
  await expect(toggle).toHaveAccessibleName("Фильтры: выбрано 0");
  await expect(toggle).toHaveText("Фильтры");

  const params = new URLSearchParams();
  for (let i = 0; i < 12; i++) params.append("tag", `Синтетический ${i}`);
  await page.goto(`${path}?${params}`);
  await expect(toggle).toHaveAccessibleName("Фильтры: выбрано 12");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(toggle).toBeVisible();
      const label = await toggle.getByText("Фильтры", { exact: true }).boundingBox();
      const count = await toggle.getByText("12", { exact: true }).boundingBox();
      expect(label).not.toBeNull();
      expect(count).not.toBeNull();
      expect(count!.x - (label!.x + label!.width)).toBeGreaterThanOrEqual(7);
      expect(Math.abs(count!.y - label!.y)).toBeLessThanOrEqual(1);
      await expectNoOverflow(page);
      await toggle.screenshot({ path: testInfo.outputPath(`filter-counter-${theme}-${width}.png`) });
    }
  }
});
