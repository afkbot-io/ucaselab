import type { Page } from "@playwright/test";
import { test, expect, expectNoOverflow } from "./fixtures";
import type { Proposal, Report, Thread } from "../src/types";

const discussionName = { name: "Обсуждения", exact: true } as const;

async function applyTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator(".loading")).toHaveCount(0);
  await expect(
    page.getByText("Не удалось загрузить данные", { exact: true }),
  ).toHaveCount(0);
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  // Media changes update the theme in an event handler. WebKit may suspend
  // offscreen transitions: inspect each real control in view with normal motion,
  // retaining both token assertions, then restore the intended capture position.
  const scrollState = await page.evaluate(() =>
    [
      document.scrollingElement,
      ...document.querySelectorAll(".workspace, dialog[open]"),
    ].map((element) => ({
      left: element?.scrollLeft || 0,
      top: element?.scrollTop || 0,
    })),
  );
  for (const secondary of await page
    .locator(".button.secondary:visible")
    .all()) {
    await secondary.scrollIntoViewIfNeeded();
    await expect(secondary).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(28, 38, 54)" : "rgb(255, 255, 255)",
    );
    await expect(secondary).toHaveCSS(
      "color",
      theme === "dark" ? "rgb(236, 240, 248)" : "rgb(24, 35, 59)",
    );
  }
  await page.evaluate((positions) => {
    const elements = [
      document.scrollingElement,
      ...document.querySelectorAll(".workspace, dialog[open]"),
    ];
    elements.forEach((element, index) =>
      element?.scrollTo({ ...positions[index], behavior: "instant" }),
    );
  }, scrollState);
  const controls = await page
    .locator(".button.secondary:visible")
    .evaluateAll((elements) =>
      elements.map((e) => {
        const style = getComputedStyle(e);
        return {
          label: e.textContent?.trim(),
          background: style.backgroundColor,
          color: style.color,
          surface: style.getPropertyValue("--surface"),
          ink: style.getPropertyValue("--ink"),
        };
      }),
    );
  await test.info().attach(`settled-secondary-${theme}`, {
    body: JSON.stringify(
      { path: new URL(page.url()).pathname, theme, controls },
      null,
      2,
    ),
    contentType: "application/json",
  });
}

test("all five discussion targets share header icons, direct links, drafts and focus", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id;
  const api = workspace.apis.owner;
  const proposal = await api.call<Proposal>("submit_proposal", pid, {
    title: "Общее оформление обсуждений",
    kind: "feature_idea",
    content: { description: "Синтетический документ" },
  });
  const report = await api.call<Report>("generate_report", pid, {
    title: "Отчёт",
    run_ids: [workspace.run.id],
    interim: true,
  });
  await api.call("confirm_run_readiness", pid, {
    run_id: workspace.run.id,
    expected_version: workspace.run.version,
    checks: {
      environment: "ready",
      accounts: "not_required",
      dependencies: "not_required",
    },
    actual_base_url: "https://example.invalid",
    notes: "Синтетическая проверка интерфейса",
  });
  await api.call("begin_run_check", pid, { run_id: workspace.run.id });
  const check = workspace.run.items[0];
  const targets = [
    {
      type: "use_case",
      id: workspace.case.id,
      url: `cases/${workspace.case.id}`,
      header: ".page-actions",
    },
    {
      type: "proposal",
      id: proposal.id,
      url: `proposals/${proposal.id}`,
      header: ".page-actions",
    },
    {
      type: "specification",
      id: workspace.spec.id,
      url: `specifications?open=${workspace.spec.id}`,
      header: ".dialog-actions",
    },
    {
      type: "report",
      id: report.id,
      url: `reports/${report.id}`,
      header: ".page-actions",
    },
    {
      type: "execution",
      id: check.attempts[0].id,
      url: `runs/${workspace.run.id}?check=${check.id}`,
      header: ".cw-check-actions",
    },
  ];
  const measurements: {
    target: string;
    width: number;
    height: number;
    background: string;
    color: string;
  }[] = [];
  for (const target of targets) {
    const thread = await api.call<Thread>("create_comment_thread", pid, {
      target_type: target.type,
      target_id: target.id,
      body: `Обсуждение ${target.type}`,
    });
    await page.goto(
      `/p/${pid}/${target.url}${target.url.includes("?") ? "&" : "?"}thread=${thread.id}`,
    );
    const trigger = page.getByRole("button", discussionName);
    const panel = page.getByRole("dialog", discussionName);
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText(`Обсуждение ${target.type}`, { exact: true }),
    ).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveAttribute("title", "Обсуждения");
    await expect(trigger).toHaveText("");
    const appearance = await trigger.evaluate((e) => {
      const style = getComputedStyle(e),
        rect = e.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        background: style.backgroundColor,
        color: style.color,
      };
    });
    expect(appearance.width).toBe(40);
    expect(appearance.height).toBe(40);
    measurements.push({ target: target.type, ...appearance });
    expect(
      await trigger.evaluate(
        (e, selector) => !!e.closest(selector),
        target.header,
      ),
    ).toBe(true);
    expect(
      await panel.evaluate(
        (e) => !!e.closest(".page-head,.dialog-head,.cw-check-meta"),
      ),
    ).toBe(false);
    expect(await panel.evaluate((e) => e.matches(":modal"))).toBe(false);
    if (target.type === "specification")
      expect(
        await panel.evaluate((e) => !!e.parentElement?.closest("dialog:modal")),
      ).toBe(true);
    const input = panel.getByLabel("Новое обсуждение", { exact: true });
    await input.fill(`Черновик ${target.type}`);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`discussion-${target.type}.png`),
    });
    await input.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue(`Черновик ${target.type}`);
    await expectNoOverflow(page);
    await input.press("Escape");
  }
  expect(
    new Set(measurements.map((m) => `${m.background}/${m.color}`)).size,
  ).toBe(1);
  await info.attach("discussion-trigger-computed-styles", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
});

test("rejected proposal deletion confirms, retains on cancel/error and returns to list", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id;
  const api = workspace.apis.owner;
  let proposal = await api.call<Proposal>("submit_proposal", pid, {
    title:
      "Отклонённое предложение с длинным названием " +
      "подробности ".repeat(12),
    kind: "feature_idea",
    content: { description: "История и решение сохраняются" },
  });
  await page.goto(`/p/${pid}/proposals/${proposal.id}`);
  await expect(
    page.getByRole("button", { name: "Удалить", exact: true }),
  ).toHaveCount(0);
  proposal = await api.call<Proposal>("reject_proposal", pid, {
    proposal_id: proposal.id,
    expected_version: proposal.version,
    reason: "Уже описано",
  });
  await page.reload();
  const remove = page
    .locator(".page-actions")
    .getByRole("button", { name: "Удалить", exact: true });
  for (const theme of ["light", "dark"] as const) {
    await applyTheme(page, theme);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(remove).toBeVisible();
      await expectNoOverflow(page);
      const title = await page.locator(".page-heading h1").boundingBox();
      const actions = await page.locator(".page-actions").boundingBox();
      expect(
        title &&
          actions &&
          (actions.y >= title.y + title.height ||
            actions.x >= title.x + title.width),
      ).toBeTruthy();
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`rejected-${theme}-${width}.png`),
      });
    }
  }
  await remove.click();
  const confirm = page.getByRole("dialog", {
    name: "Удалить отклонённое предложение",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await expect(confirm.locator(".form-footer")).toHaveCSS("display", "flex");
  await expect(confirm.locator(".form-footer")).toHaveCSS("column-gap", "8px");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("delete-confirmation.png"),
  });
  await confirm.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(
    (
      await api.call<Proposal>("get_proposal", pid, {
        proposal_id: proposal.id,
      })
    ).version,
  ).toBe(proposal.version);
  await remove.click();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  let releaseRequest: () => void = () => {};
  const release = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await page.route("**/api/actions/delete_proposal", async (route) => {
    await release;
    await route.fulfill({
      status: 503,
      json: { detail: "Синтетическая ошибка удаления" },
    });
  });
  await remove.click();
  await confirm.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(
    confirm.getByRole("button", { name: "Удалить", exact: true }),
  ).toBeDisabled();
  await expect(
    confirm.getByRole("button", { name: "Отмена", exact: true }),
  ).toBeDisabled();
  await expect(confirm.getByRole("status")).toHaveText("Удаляем…");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("delete-pending.png"),
  });
  await page.keyboard.press("Escape");
  await expect(confirm).toBeVisible();
  releaseRequest();
  await expect(confirm.getByRole("alert")).toHaveText(
    /Синтетическая ошибка удаления/,
  );
  await expect(confirm).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("delete-error.png"),
  });
  await page.unroute("**/api/actions/delete_proposal");
  await confirm.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}/proposals$`));
  await expect(page.getByRole("link", { name: proposal.title })).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("after-deletion.png"),
  });
  await page.goto(`/p/${pid}/proposals/${proposal.id}`);
  await expect(
    page.getByText("Предложение не найдено", { exact: true }),
  ).toBeVisible();
});

test("proposal deletion availability matches author and QA roles and terminal status", async ({
  workspace,
}) => {
  const pid = workspace.project.id;
  const api = workspace.apis.owner;
  const own = await api.call<Proposal>("submit_proposal", pid, {
    title: "Чужое предложение",
    kind: "feature_idea",
    content: { description: "Идея" },
  });
  const dev = await workspace.asRole("developer");
  const forbidden = await workspace.apis.developer.raw("delete_proposal", pid, {
    proposal_id: own.id,
    expected_version: 1,
  });
  expect(forbidden.status()).toBe(404);
  await dev.page.goto(`/p/${pid}/proposals/${own.id}`);
  await expect(
    dev.page.getByRole("button", { name: "Удалить", exact: true }),
  ).toHaveCount(0);
  for (const state of ["accepted", "withdrawn", "rejected"] as const) {
    let p = await workspace.apis.developer.call<Proposal>(
      "submit_proposal",
      pid,
      {
        title: `Состояние ${state}`,
        kind: "feature_idea",
        content: { description: "Идея" },
      },
    );
    p = await (
      state === "withdrawn" ? workspace.apis.developer : api
    ).call<Proposal>(
      state === "accepted"
        ? "accept_proposal"
        : state === "withdrawn"
          ? "withdraw_proposal"
          : "reject_proposal",
      pid,
      {
        proposal_id: p.id,
        expected_version: p.version,
        ...(state === "rejected" ? { reason: "Дубликат" } : {}),
      },
    );
    await dev.page.goto(`/p/${pid}/proposals/${p.id}`);
    await expect(
      dev.page.getByRole("heading", { name: p.title, exact: true }),
    ).toBeVisible();
    await expect(
      dev.page.getByRole("button", { name: "Удалить", exact: true }),
    ).toHaveCount(state === "rejected" ? 1 : 0);
    if (state === "rejected") {
      const qa = await workspace.asRole("tester");
      await qa.page.goto(`/p/${pid}/proposals/${p.id}`);
      await expect(
        qa.page.getByRole("button", { name: "Удалить", exact: true }),
      ).toBeVisible();
      await dev.page
        .getByRole("button", { name: "Удалить", exact: true })
        .click();
      await dev.page
        .getByRole("dialog")
        .getByRole("button", { name: "Удалить", exact: true })
        .click();
      await expect(dev.page).toHaveURL(new RegExp(`/p/${pid}/proposals$`));
    }
  }
});

for (const group of [
  ["cases", "specifications", "accounts", "proposals"],
  ["plans", "runs", "reports", "notifications"],
  ["settings", "profile", "profile?tab=profile", "profile?tab=skills"],
  [
    "settings?tab=team",
    "settings?tab=environments",
    "settings?tab=guide",
    "settings?tab=notifications",
    "settings?tab=audit",
  ],
]) {
  test(`route appearance audit: ${group.join(", ")}`, async ({
    page,
    workspace,
  }, info) => {
    for (const route of group) {
      const settingsTab = route.startsWith("settings?tab=")
        ? route.split("=")[1]
        : null;
      await page.goto(
        `/p/${workspace.project.id}/${settingsTab ? "settings" : route}`,
      );
      if (settingsTab) {
        // Settings tabs are local UI state; query parameters do not select them.
        const settings: Record<string, [string, string]> = {
          team: ["Команда", "Участники проекта"],
          environments: ["Окружения", "Окружения"],
          guide: ["Инструкции ИИ", "Инструкции проекта для ИИ"],
          notifications: ["Уведомления", "Личные уведомления в проекте"],
          audit: ["Аудит", "Журнал действий"],
        };
        const [label, heading] = settings[settingsTab];
        const tab = page.getByRole("tab", { name: label, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(
          page.getByRole("heading", { name: heading, exact: true }),
        ).toBeVisible();
      }
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(
        page.getByText("Не удалось загрузить данные", { exact: true }),
      ).toHaveCount(0);
      for (const theme of ["light", "dark"] as const) {
        await applyTheme(page, theme);
        await expectNoOverflow(page);
        await page.screenshot({
          animations: "disabled",
          path: info.outputPath(
            `${route.replaceAll(/[?=]/g, "-")}-${theme}.png`,
          ),
        });
      }
    }
  });
}

test("document, form and workspace appearance audit", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id;
  const api = workspace.apis.owner;
  const proposal = await api.call<Proposal>("submit_proposal", pid, {
    title: "Проверка оформления",
    kind: "feature_idea",
    content: { description: "Документ" },
  });
  const report = await api.call<Report>("generate_report", pid, {
    title: "Снимок",
    run_ids: [workspace.run.id],
    interim: true,
  });
  const routes = [
    { key: "projects", path: "/" },
    { key: "invitation", path: "/invite" },
    { key: "case", path: `/p/${pid}/cases/${workspace.case.id}` },
    { key: "plan", path: `/p/${pid}/plans/${workspace.plan.id}` },
    { key: "run", path: `/p/${pid}/runs/${workspace.run.id}` },
    { key: "proposal", path: `/p/${pid}/proposals/${proposal.id}` },
    { key: "report", path: `/p/${pid}/reports/${report.id}` },
    {
      key: "specification-modal",
      path: `/p/${pid}/specifications?open=${workspace.spec.id}`,
    },
    { key: "proposal-form", path: `/p/${pid}/proposals?new=1` },
    { key: "global-profile", path: "/profile" },
  ];
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (route.key === "invitation") {
      await expect(
        page.getByRole("button", { name: "Принять приглашение", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByText(
          "Откройте ссылку приглашения, которую вам прислал участник проекта.",
          { exact: true },
        ),
      ).toBeVisible();
    }
    if (["proposal-form", "specification-modal"].includes(route.key))
      await expect(page.getByRole("dialog")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await applyTheme(page, theme);
      await expectNoOverflow(page);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`${route.key}-${theme}.png`),
      });
    }
  }
  await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("case-editor.png"),
  });
});

test("focused specification edit uses the theme surface and shared keyboard focus", async ({
  page,
  workspace,
}, info) => {
  await page.goto(
    `/p/${workspace.project.id}/specifications?open=${workspace.spec.id}`,
  );
  const modal = page.getByRole("dialog", {
    name: workspace.spec.title,
    exact: true,
  });
  const edit = modal.getByRole("button", { name: "Изменить", exact: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await edit.focus();
  await expect(edit).toBeFocused();
  await expect(edit).toHaveCSS("background-color", "rgb(28, 38, 54)");
  await expect(edit).toHaveCSS("color", "rgb(236, 240, 248)");
  await expect(edit).toHaveCSS("outline-color", "rgb(164, 183, 255)");
  await expect(edit).toHaveCSS("outline-style", "solid");
  const styles = await edit.evaluate((e) => {
    const s = getComputedStyle(e);
    return {
      background: s.backgroundColor,
      color: s.color,
      outline: s.outline,
      surface: s.getPropertyValue("--surface"),
      ink: s.getPropertyValue("--ink"),
    };
  });
  await info.attach("focused-secondary-computed-styles", {
    body: JSON.stringify(styles, null, 2),
    contentType: "application/json",
  });
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("focused-specification-edit-dark.png"),
  });
});

test.describe("public form appearance audit", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("auth forms keep native focus, themed inputs and narrow layout", async ({
    page,
  }, info) => {
    for (const route of ["login", "register", "reset", "link", "verify"]) {
      await page.goto(`/auth/${route}`);
      await expect(page.locator(".auth-form")).toBeVisible();
      for (const theme of ["light", "dark"] as const) {
        await applyTheme(page, theme);
        await expectNoOverflow(page);
        await page.screenshot({
          animations: "disabled",
          path: info.outputPath(`auth-${route}-${theme}.png`),
        });
      }
    }
    await page.goto("/invite");
    await expect(page).toHaveURL(/\/auth\/login$/);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("invitation-login-required.png"),
    });
  });
});

test("execution result modal, account view and activity share header and drawer conventions", async ({
  page,
  workspace,
}, info) => {
  const pid = workspace.project.id;
  const api = workspace.apis.owner;
  await api.call("confirm_run_readiness", pid, {
    run_id: workspace.run.id,
    expected_version: workspace.run.version,
    checks: {
      environment: "ready",
      accounts: "not_required",
      dependencies: "not_required",
    },
    actual_base_url: "https://example.invalid",
    notes: "Синтетическое выполнение",
  });
  const started = await api.call<{ check: { attempts: { id: string }[] } }>(
    "begin_run_check",
    pid,
    { run_id: workspace.run.id },
  );
  await api.call("finish_run_check", pid, {
    execution_id: started.check.attempts.at(-1)!.id,
    status: "blocked",
    actual_result: "Синтетический стенд недоступен",
  });
  await page.goto(`/p/${pid}/cases/${workspace.case.id}?tab=executions`);
  await page
    .getByRole("button", { name: "Подробнее", exact: true })
    .first()
    .click();
  const result = page.getByRole("dialog", {
    name: "Результат проверки",
    exact: true,
  });
  const trigger = result.getByRole("button", discussionName);
  await expect(trigger).toHaveCSS("width", "40px");
  await trigger.click();
  const drawer = page.getByRole("dialog", discussionName);
  await expect(drawer).toBeVisible();
  expect(
    await drawer.evaluate((e) => !!e.parentElement?.closest("dialog:modal")),
  ).toBe(true);
  await drawer
    .getByLabel("Новое обсуждение", { exact: true })
    .fill("Черновик результата");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(result).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await applyTheme(page, theme);
    await expectNoOverflow(page);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`execution-result-${theme}.png`),
    });
  }
  await page.keyboard.press("Escape");
  await expect(result).toHaveCount(0);
  const account = await api.call<{ id: string }>("create_test_account", pid, {
    name: "Синтетический аккаунт",
    login: "synthetic@example.invalid",
  });
  await page.goto(`/p/${pid}/accounts?open=${account.id}`);
  await expect(
    page.getByRole("dialog", { name: "Синтетический аккаунт", exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await applyTheme(page, theme);
    await expectNoOverflow(page);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`account-detail-${theme}.png`),
    });
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^История изменений/ }).click();
  await expect(
    page.getByRole("dialog", { name: "История изменений", exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await applyTheme(page, theme);
    await expectNoOverflow(page);
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath(`activity-${theme}.png`),
    });
  }
});
