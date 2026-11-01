import { test, expect, expectNoOverflow } from "./fixtures";

const historyName = /^История изменений/;

test("own writes stay read while another actor creates personal unread history", async ({ page, workspace }) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  const history = page.getByRole("button", { name: historyName });
  await expect(history).toHaveAccessibleName("История изменений");
  await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
  const discussion = page.getByRole("dialog", { name: "Обсуждения", exact: true });
  await discussion.getByLabel("Новое обсуждение", { exact: true }).fill("Собственное изменение");
  await discussion.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(discussion.getByText("Собственное изменение", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(history).toHaveAccessibleName("История изменений");
  await history.click();
  const drawer = page.getByRole("dialog", { name: "История изменений", exact: true });
  await expect(drawer.locator(".activity-list article").first()).toContainText("Прочитано");
  await expect(drawer.locator("article.unread")).toHaveCount(0);
  await drawer.getByLabel("Состояние чтения", { exact: true }).selectOption("read");
  await expect(drawer.locator(".activity-list article").first()).toContainText("Обсуждения");
  await drawer.getByLabel("Состояние чтения", { exact: true }).selectOption("unread");
  await expect(drawer.getByText("По фильтрам ничего не найдено", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await workspace.apis.tester.call("create_comment_thread", pid, {
    use_case_id: workspace.case.id, body: "Изменение коллеги",
  });
  await page.reload();
  await expect(history).toHaveAccessibleName("История изменений: 1 непрочитанных");
  await history.click();
  await expect(drawer.locator("article.unread")).toHaveCount(1);
  const feed = await workspace.apis.owner.call<{ unread_count: number }>("list_activity", pid);
  expect(feed.unread_count).toBe(1); // Opening alone leaves other people's events unread.
  await drawer.getByLabel("Автор события", { exact: true }).selectOption(workspace.identities.owner.id);
  await expect(drawer.locator("article.unread")).toHaveCount(0);
  await expect(drawer.locator(".activity-list article").first()).toBeVisible();
});

test("history filters reset, validate local periods and keep a native edge scrollbar across themes and widths", async ({ page, workspace }, info) => {
  const pid = workspace.project.id;
  for (let i = 0; i < 34; i++)
    await workspace.apis.owner.call("create_comment_thread", pid, {
      use_case_id: workspace.case.id, body: `Длинная история ${i}`,
    });
  await page.goto(`/p/${pid}/cases`);
  await page.getByRole("button", { name: historyName }).click();
  const drawer = page.getByRole("dialog", { name: "История изменений", exact: true });
  const entity = drawer.getByLabel("Тип объекта", { exact: true });
  const event = drawer.getByLabel("Событие", { exact: true });
  const reset = drawer.getByRole("button", { name: /^Сбросить фильтры/ });
  await entity.selectOption("thread");
  await event.selectOption("discussion.created");
  await entity.selectOption("report");
  await expect(event).toHaveValue("");
  await expect(event.locator("option")).toHaveCount(2);
  await expect(drawer.getByText("По фильтрам ничего не найдено", { exact: true })).toBeVisible();
  await reset.click();
  await expect(entity).toHaveValue("");
  await expect(reset).toBeDisabled();
  await expect(drawer.getByLabel("Проект истории", { exact: true })).toHaveValue(pid);
  await drawer.getByText("Период · за всё время", { exact: true }).click();
  const since = drawer.getByLabel("С даты", { exact: true });
  const until = drawer.getByLabel("До даты", { exact: true });
  await since.fill("2025-06-02T12:30");
  await until.fill("2025-06-01T12:30");
  await expect(drawer.getByRole("alert")).toHaveText("Начало периода должно быть не позже окончания.");
  await expect(drawer.getByRole("button", { name: "Ещё события", exact: true })).toHaveCount(0);
  const expectedISO = await page.evaluate(() => new Date("2025-06-02T12:30").toISOString());
  const response = page.waitForResponse(r => r.url().endsWith("/api/actions/list_activity") && r.request().postDataJSON().arguments.since === expectedISO);
  await until.fill("2025-06-03T12:30");
  await response;
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  await expect(drawer.getByText("По фильтрам ничего не найдено", { exact: true })).toBeVisible();
  await reset.click();
  await expect(since).toHaveValue("");
  await expect(until).toHaveValue("");
  await expect(drawer.locator(".activity-list article")).toHaveCount(30);
  await entity.selectOption("thread");
  await expect(drawer.locator(".activity-list article")).toHaveCount(30);
  const scroll = drawer.getByRole("region", { name: "Содержимое панели", exact: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await scroll.evaluate(el => { el.scrollTop = 0; });
      const geometry = await scroll.evaluate(el => {
        const drawer = el.closest("dialog")!, r = el.getBoundingClientRect(), d = drawer.getBoundingClientRect();
        return { right: d.right - r.right, overflow: el.scrollHeight > el.clientHeight, horizontal: el.scrollWidth - el.clientWidth, padding: parseFloat(getComputedStyle(el).paddingRight) };
      });
      expect(geometry.right).toBeLessThanOrEqual(2);
      expect(geometry.overflow).toBe(true);
      expect(geometry.horizontal).toBeLessThanOrEqual(1);
      expect(geometry.padding).toBeGreaterThanOrEqual(18);
      await expectNoOverflow(page);
      await scroll.focus();
      await expect(scroll).toBeFocused();
      await scroll.press("PageDown");
      await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await expect(drawer.getByRole("button", { name: "Закрыть окно", exact: true })).toBeInViewport();
      // Let the browser finish its native keyboard animation before positioning evidence.
      await scroll.evaluate(async (el) => {
        let previous = el.scrollTop, stableFrames = 0;
        while (stableFrames < 6) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const current = el.scrollTop;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
        }
        el.scrollTop = 0;
      });
      await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(0);
      await page.screenshot({ path: info.outputPath(`history-${theme}-${width}-filters.png`) });
      await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.screenshot({ path: info.outputPath(`history-${theme}-${width}-scrolled.png`) });
    }
  }
  await drawer.getByRole("button", { name: "Ещё события", exact: true }).click();
  await expect(drawer.locator(".activity-list article")).not.toHaveCount(30);
});

test("selected author remains visible across project scope and invalid periods", async ({ page, workspace }) => {
  const pid = workspace.project.id;
  await workspace.apis.tester.call("create_comment_thread", pid, {
    use_case_id: workspace.case.id, body: "Автор только первого проекта",
  });
  const second = await workspace.apis.owner.call<{ id: string }>("create_project", null, {
    name: "Другой проект фильтра автора", key: "A" + pid.replaceAll("-", "").slice(0, 8).toUpperCase(),
  });
  await workspace.apis.owner.call("create_specification", second.id, { title: "История другого проекта" });
  await page.goto(`/p/${pid}/cases`);
  await page.getByRole("button", { name: historyName }).click();
  const drawer = page.getByRole("dialog", { name: "История изменений", exact: true });
  const author = drawer.getByLabel("Автор события", { exact: true });
  const tester = workspace.identities.tester.id;
  await expect(author.locator(`option[value="${tester}"]`)).toBeAttached();
  await author.selectOption(tester);
  await expect(drawer.locator("article.unread")).toHaveCount(1);
  await drawer.getByText("Период · за всё время", { exact: true }).click();
  await drawer.getByLabel("С даты", { exact: true }).fill("2025-06-02T12:30");
  await drawer.getByLabel("До даты", { exact: true }).fill("2025-06-01T12:30");
  await expect(drawer.getByRole("alert")).toBeVisible();
  await expect(author).toHaveValue(tester);
  await expect(author.locator("option:checked")).toHaveText("E2E tester");
  await drawer.getByLabel("С даты", { exact: true }).fill("");
  await drawer.getByLabel("До даты", { exact: true }).fill("");
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  const scoped = page.waitForResponse(r => r.url().endsWith("/api/actions/list_activity") && r.request().postDataJSON().project_id === second.id);
  await drawer.getByLabel("Проект истории", { exact: true }).selectOption(second.id);
  const response = await scoped;
  expect(response.request().postDataJSON().arguments.actor_id).toBe(tester);
  await expect(drawer.getByText("По фильтрам ничего не найдено", { exact: true })).toBeVisible();
  await expect(author).toHaveValue(tester);
  await expect(author.locator("option:checked")).toHaveText("E2E tester");
  await drawer.getByRole("button", { name: /^Сбросить фильтры/ }).click();
  await expect(author).toHaveValue("");
  await expect(author.locator("option:checked")).toHaveText("Все авторы");
  await expect(drawer.getByLabel("Проект истории", { exact: true })).toHaveValue(pid);
  await expect(drawer.locator(".activity-list article").first()).toBeVisible();
});
