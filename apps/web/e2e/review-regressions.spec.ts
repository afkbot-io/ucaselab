import { test, expect } from "./fixtures";
import type { Member } from "../src/types";

test("a delayed activity page cannot reappear after changing filters", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  for (let i = 0; i < 32; i++)
    await workspace.apis.owner.call("create_comment_thread", pid, {
      use_case_id: workspace.case.id,
      body: `Старая страница ${i}`,
    });
  await page.goto(`/p/${pid}/cases`);
  await page.getByRole("button", { name: /^История изменений/ }).click();
  const drawer = page.getByRole("dialog", {
    name: "История изменений",
    exact: true,
  });
  const next = drawer.getByRole("button", { name: "Ещё события", exact: true });
  await expect(next).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const received = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/actions/list_activity", async (route) => {
    const args = route.request().postDataJSON().arguments;
    if (args.before) {
      const response = await route.fetch();
      requested();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await next.click();
    await received;
    await drawer
      .getByLabel("Тип объекта", { exact: true })
      .selectOption("report");
    await expect(
      drawer.getByText("По фильтрам ничего не найдено", { exact: true }),
    ).toBeVisible();
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/actions/list_activity") &&
        !!r.request().postDataJSON().arguments.before,
    );
    release();
    await (await response).finished();
    await page.waitForLoadState("networkidle");
    await expect(drawer.locator(".activity-list article")).toHaveCount(0);
    await expect(
      drawer.getByText("По фильтрам ничего не найдено", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

test("mention names render literally and do not create Markdown links", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  const members = await workspace.apis.owner.call<{ items: Member[] }>(
    "list_project_members",
    pid,
  );
  const tester = members.items.find((m) => m.role === "tester")!;
  await workspace.apis.tester.profile({
    name: "[Подмена](https://example.com)",
  });
  try {
    await workspace.apis.owner.call("create_comment_thread", pid, {
      use_case_id: workspace.case.id,
      body: `Вопрос @{${tester.user_id}}`,
    });
    await page.goto(`/p/${pid}/cases/${workspace.case.id}`);
    await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
    const body = page
      .getByRole("dialog", { name: "Обсуждения", exact: true })
      .locator(".comment-body");
    await expect(body).toHaveText("Вопрос @[Подмена](https://example.com)");
    await expect(body.getByRole("link")).toHaveCount(0);
  } finally {
    await workspace.apis.tester.profile({ name: tester.name });
  }
});

test("history close control stays reachable and notification panel has one heading", async ({
  page,
  workspace,
}, info) => {
  await page.goto(`/p/${workspace.project.id}/cases`);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: /^История изменений/ }).click();
    const drawer = page.getByRole("dialog", {
      name: "История изменений",
      exact: true,
    });
    const close = drawer.getByRole("button", {
      name: "Закрыть окно",
      exact: true,
    });
    const box = await close.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(32);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await close.click();
  }
  await page.getByRole("link", { name: /^Уведомления/ }).click();
  const drawer = page.getByRole("dialog", { name: "Уведомления", exact: true });
  await expect(
    drawer.getByRole("heading", { name: "Уведомления", exact: true }),
  ).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath("notifications-reviewed.png"),
  });
});

test("QA-only replies do not suggest developers who cannot read the thread", async ({
  page,
  workspace,
}) => {
  const c = workspace.case,
    pid = workspace.project.id;
  const draft = await workspace.apis.owner.call<{ revision_id: string }>(
    "save_use_case_draft",
    pid,
    {
      use_case_id: c.id,
      expected_version: c.version,
      base_revision_id: c.revision_id,
      content: { ...c.content, goal: "Внутреннее уточнение QA" },
    },
  );
  await workspace.apis.owner.call("create_comment_thread", pid, {
    use_case_id: c.id,
    body: "QA-only",
    anchor: {
      revision_id: draft.revision_id,
      field_path: "steps/open",
      step_key: "open",
      quote: "Открыть страницу",
    },
  });
  await page.goto(`/p/${pid}/cases/${c.id}`);
  await page.getByRole("button", { name: "Обсуждения", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Обсуждения", exact: true });
  await drawer.getByLabel("Ответить", { exact: true }).fill("@");
  await expect(drawer.getByRole("listbox")).toBeVisible();
  await expect(
    drawer.getByRole("option", { name: "E2E developer", exact: true }),
  ).toHaveCount(0);
  await expect(
    drawer.getByRole("option", { name: "E2E tester", exact: true }),
  ).toBeVisible();
});
