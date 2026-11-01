import { test, expect } from "./fixtures";

const panelName = { name: "Обсуждения", exact: true } as const;

test("removing anchor preserves visible text when there is no general draft", async ({
  page,
  workspace,
}) => {
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  await page
    .getByRole("button", { name: "Обсудить шаг 1", exact: true })
    .click();
  const panel = page.getByRole("dialog", panelName);
  const input = panel.getByLabel("Новое обсуждение", { exact: true });
  await input.fill("Текст к фрагменту");
  await panel
    .getByRole("button", { name: "Убрать привязку", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Убрать привязку?", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Убрать привязку", exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("Текст к фрагменту");
  await page.keyboard.press("Escape");
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Текст к фрагменту");
  await panel.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(panel.locator(".comment-body")).toHaveText("Текст к фрагменту");
  await expect(panel.locator(".thread-anchor")).toHaveCount(0);
});

test("occupied general draft requires an explicit non-destructive merge when removing anchor", async ({
  page,
  workspace,
}, info) => {
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  const panel = page.getByRole("dialog", panelName);
  const input = panel.getByLabel("Новое обсуждение", { exact: true });
  const close = panel.getByRole("button", {
    name: "Закрыть окно",
    exact: true,
  });
  await page.getByRole("button", panelName).click();
  await input.fill("Общий черновик");
  await close.click();
  await page
    .getByRole("button", { name: "Обсудить шаг 1", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await input.fill("Черновик первого шага");
  await close.click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Черновик первого шага");
  await panel
    .getByRole("button", { name: "Убрать привязку", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Убрать привязку?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  expect(await confirmation.evaluate((e) => e.matches(":modal"))).toBe(true);
  await page.screenshot({ path: info.outputPath("anchor-merge.png") });
  await expect(
    confirmation.getByText("Общий черновик", { exact: true }),
  ).toBeVisible();
  await expect(
    confirmation.getByText("Черновик первого шага", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(input).toHaveValue("Черновик первого шага");
  await expect(
    panel.getByRole("button", { name: "Убрать привязку", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Убрать привязку", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Объединить и убрать привязку", exact: true })
    .click();
  await expect(input).toHaveValue("Черновик первого шага\n\nОбщий черновик");
  await expect(
    panel.getByRole("button", { name: "Убрать привязку", exact: true }),
  ).toHaveCount(0);
  await close.click();
  await page.getByRole("button", panelName).click();
  await expect(input).toHaveValue("Черновик первого шага\n\nОбщий черновик");
  await close.click();
  await page
    .getByRole("button", { name: "Обсудить шаг 1", exact: true })
    .click();
  await expect(input).toHaveValue("Черновик первого шага");
  await panel.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(input).toHaveValue("Черновик первого шага\n\nОбщий черновик");
  await expect(panel.locator(".thread-anchor")).toContainText(
    "Откройте страницу /login.",
  );
});
