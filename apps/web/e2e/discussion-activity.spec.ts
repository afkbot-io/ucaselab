import AxeBuilder from "@axe-core/playwright";
import { test, expect, expectNoOverflow } from "./fixtures";
import type { Proposal, Report, Run, Thread } from "../src/types";

test("all discussion targets support safe formatting and activity preserves personal unread", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id,
    api = workspace.apis.owner;
  const proposal = await api.call<Proposal>("submit_proposal", pid, {
    title: "Обсудить доработку",
    kind: "feature_idea",
    content: { description: "Проверим обсуждение" },
  });
  const report = await api.call<Report>("generate_report", pid, {
    title: "Обсуждение отчёта",
    run_ids: [workspace.run.id],
    interim: true,
  });
  const run = await api.call<Run>("get_run", pid, { run_id: workspace.run.id });
  const attempt = run.items[0].attempts[0];
  const targets = [
    {
      type: "proposal",
      id: proposal.id,
      url: `/p/${pid}/proposals/${proposal.id}`,
    },
    {
      type: "specification",
      id: workspace.spec.id,
      url: `/p/${pid}/specifications?open=${workspace.spec.id}`,
    },
    { type: "report", id: report.id, url: `/p/${pid}/reports/${report.id}` },
    {
      type: "execution",
      id: attempt.id,
      url: `/p/${pid}/runs/${run.id}?check=${run.items[0].id}`,
    },
  ];
  for (const target of targets) {
    await page.goto(target.url);
    if (target.type === "execution") {
      await page
        .getByLabel("Стенд открывается?", { exact: true })
        .selectOption("ready");
      await page
        .getByLabel("Доступы для проверки готовы?", { exact: true })
        .selectOption("not_required");
      await page
        .getByLabel("Зависимости доступны?", { exact: true })
        .selectOption("not_required");
      await page
        .getByRole("button", { name: "Сохранить подготовку", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Начать проверку", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Обсуждения", exact: true });
    await panel
      .getByLabel("Новое обсуждение", { exact: true })
      .fill(
        `**Вопрос ${target.type}**\n- Пункт\n<script>alert(1)</script>\n[опасно](javascript:alert(1))`,
      );
    await panel.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect(
      panel.locator("strong").filter({ hasText: `Вопрос ${target.type}` }),
    ).toBeVisible();
    expect(await panel.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await panel.locator("script").count()).toBe(0);
    await panel
      .getByLabel("Ответить", { exact: true })
      .fill("Ответ по доработке");
    await panel
      .getByRole("button", { name: "Отправить ответ", exact: true })
      .click();
    await expect(
      panel.getByText("Ответ по доработке", { exact: true }),
    ).toBeVisible();
    await expectNoOverflow(page);
    await page.keyboard.press("Escape");
    const saved = await api.call<{ items: Thread[] }>(
      "list_comment_threads",
      pid,
      { target_type: target.type, target_id: target.id },
    );
    expect(saved.items[0].comments.length).toBe(2);
  }
  await page.goto(`/p/${pid}/cases`);
  await workspace.apis.tester.call("create_comment_thread", pid, {
    use_case_id: workspace.case.id,
    body: "Событие другого участника",
  });
  const before = await api.call<{ unread_count: number }>("list_activity", pid);
  const history = page.getByRole("button", { name: /^История изменений/ });
  await history.click();
  const drawer = page.getByRole("dialog", {
    name: "История изменений",
    exact: true,
  });
  await expect(
    drawer.getByText("Не прочитано", { exact: true }).first(),
  ).toBeVisible();
  expect(
    (await api.call<{ unread_count: number }>("list_activity", pid))
      .unread_count,
  ).toBe(before.unread_count);
  await drawer
    .getByLabel("Тип объекта", { exact: true })
    .selectOption("thread");
  await expect(drawer.locator(".activity-list article").first()).toContainText(
    "Обсуждения",
  );
  const scan = await new AxeBuilder({ page })
    .include(".activity-drawer")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("history-light.png") });
  await drawer
    .getByRole("button", { name: "Прочитать показанные", exact: true })
    .click();
  await expect(drawer.getByText("Не прочитано", { exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(history).toBeFocused();
  await page.getByRole("link", { name: /^Уведомления/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Уведомления", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("mention autocomplete supports keyboard, direct notifications and mobile themes", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Обсуждения", exact: true });
  const input = drawer.getByLabel("Новое обсуждение", { exact: true });
  await input.fill("Вопрос @");
  await expect(drawer.getByRole("listbox")).toBeVisible();
  await input.press("Escape");
  await expect(drawer.getByRole("listbox")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await input.fill("Вопрос @E2E tester");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue(/@\{[a-f0-9-]{36}\}/);
  const scan = await new AxeBuilder({ page })
    .include(".discussion-drawer")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  await drawer.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(drawer.locator(".comment-body")).toContainText("Вопрос @");
  const tester = await workspace.asRole("tester");
  await tester.page.goto(`/p/${pid}/cases`);
  await tester.page.getByRole("link", { name: /^Уведомления/ }).click();
  const notifications = tester.page.getByRole("dialog", {
    name: "Уведомления",
    exact: true,
  });
  await notifications
    .getByRole("button", { name: "Открыть", exact: false })
    .first()
    .click();
  await expect(
    tester.page.getByRole("dialog", { name: "Обсуждения", exact: true }),
  ).toBeVisible();
  await expect(tester.page.locator(".comment-body")).toContainText(
    "Вопрос @E2E tester",
  );
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectNoOverflow(page);
    await page.screenshot({
      path: info.outputPath(`mentions-${width}-light.png`),
    });
  }
  await workspace.apis.owner.profile({ theme: "dark" });
  await page.reload();
  await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoOverflow(page);
  await page.screenshot({ path: info.outputPath("mentions-390-dark.png") });
});
