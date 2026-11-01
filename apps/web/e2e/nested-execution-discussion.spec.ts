import { test, expect } from "./fixtures";
import type { Thread } from "../src/types";

test("execution result discussion owns only its manual panel under a case thread link", async ({
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
    notes: "Синтетический результат",
  });
  const started = await api.call<{ check: { attempts: { id: string }[] } }>(
    "begin_run_check",
    pid,
    { run_id: workspace.run.id },
  );
  const execution = started.check.attempts.at(-1)!.id;
  await api.call("finish_run_check", pid, {
    execution_id: execution,
    status: "blocked",
    actual_result: "Синтетический результат для обсуждения",
  });
  const parentThread = await api.call<Thread>("create_comment_thread", pid, {
    use_case_id: workspace.case.id,
    body: "Ветка кейса",
  });
  await api.call("create_comment_thread", pid, {
    target_type: "execution",
    target_id: execution,
    body: "Ветка результата",
  });
  await page.goto(
    `/p/${pid}/cases/${workspace.case.id}?thread=${parentThread.id}`,
  );
  const parent = page.locator(".case-page-wrap > dialog.discussion-drawer");
  await expect(parent).toBeVisible();
  const parentDraft = parent.getByLabel("Новое обсуждение", { exact: true });
  await parentDraft.fill("Черновик кейса сохраняется");
  // Real keyboard activation also reaches background content on a narrow
  // viewport, where the nonmodal drawer covers the pointer hit area.
  await page.getByRole("tab", { name: /^Проверки/ }).focus();
  await page.keyboard.press("Enter");
  const details = page
    .getByRole("row")
    .filter({ hasText: "Синтетический результат для обсуждения" })
    .getByRole("button", { name: "Подробнее", exact: true });
  await details.focus();
  await page.keyboard.press("Enter");
  const result = page.getByRole("dialog", {
    name: "Результат проверки",
    exact: true,
  });
  await expect(result).toBeVisible();
  const trigger = result.getByRole("button", {
    name: "Обсуждения",
    exact: true,
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(result.locator("dialog.discussion-drawer")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("thread")).toBe(parentThread.id);
  await trigger.click();
  const nested = result.getByRole("dialog", {
    name: "Обсуждения",
    exact: true,
  });
  await expect(
    nested.getByText("Ветка результата", { exact: true }),
  ).toBeVisible();
  await expect(nested.getByText("Ветка кейса", { exact: true })).toHaveCount(0);
  await nested
    .getByLabel("Новое обсуждение", { exact: true })
    .fill("Черновик результата сохраняется");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("nested-execution-parent-thread.png"),
  });
  await page.keyboard.press("Escape");
  await expect(nested).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(result).toBeVisible();
  expect(new URL(page.url()).searchParams.get("thread")).toBe(parentThread.id);
  await page.keyboard.press("Enter");
  await expect(
    nested.getByLabel("Новое обсуждение", { exact: true }),
  ).toHaveValue("Черновик результата сохраняется");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(result).toHaveCount(0);
  await expect(parentDraft).toHaveValue("Черновик кейса сохраняется");
  await expect(parent.getByText("Ветка кейса", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("thread")).toBe(parentThread.id);
});
