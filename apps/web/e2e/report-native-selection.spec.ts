import { test, expect } from "./fixtures";

test("report run selection preserves native hit targets while scrolling", async ({ page, workspace, api }, info) => {
  test.setTimeout(60_000);
  const runIds: string[] = [];
  for (let index = 0; index < 20; index++) {
    const run = await api.call<{ id: string }>("create_run", workspace.project.id, {
      title: "Синтетический прогон " + index,
      use_case_ids: [workspace.case.id], environment_id: workspace.env.id,
    });
    runIds.push(run.id);
  }
  await page.goto(`/p/${workspace.project.id}/reports`);
  await page.getByRole("button", { name: "Новый отчёт", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Создать снимок отчёта", exact: true });
  await dialog.getByRole("checkbox", { name: "Промежуточный отчёт по незавершённой работе", exact: true }).check();
  const unrelated = dialog.getByRole("checkbox", { name: "Синтетический прогон 19", exact: false });
  await expect(unrelated).not.toBeChecked();
  await unrelated.check();
  await expect(unrelated).toBeChecked();
  const checkbox = dialog.getByRole("checkbox", { name: workspace.run.title, exact: false });
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).not.toBeInViewport();
  const pointerHits = await checkbox.evaluateHandle(input => {
    const hits: { type: string; targetMatches: boolean; inside: boolean }[] = [];
    for (const type of ["pointerdown", "pointerup", "click"]) {
      document.addEventListener(type, event => {
        const pointer = event as PointerEvent;
        const rect = input.getBoundingClientRect();
        hits.push({ type, targetMatches: event.target === input,
          inside: pointer.clientX >= rect.left && pointer.clientX < rect.right
            && pointer.clientY >= rect.top && pointer.clientY < rect.bottom });
      }, { once: true, capture: true });
    }
    return hits;
  });
  await checkbox.click();
  const hits = await pointerHits.jsonValue();
  await pointerHits.dispose();
  await info.attach("report-native-hit-targets", { body: JSON.stringify(hits), contentType: "application/json" });
  expect(hits).toEqual([
    { type: "pointerdown", targetMatches: true, inside: true },
    { type: "pointerup", targetMatches: true, inside: true },
    { type: "click", targetMatches: true, inside: true },
  ]);
  await expect(checkbox).toBeChecked();
  await expect(unrelated).toBeChecked();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  await expect(unrelated).toBeChecked();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(unrelated).toBeChecked();
  await page.screenshot({ path: info.outputPath("report-native-scroll.png"), fullPage: true });
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/actions/generate_report") && response.request().method() === "POST"),
    dialog.getByRole("button", { name: "Создать отчёт", exact: true }).click(),
  ]);
  const expectedIds = [runIds.at(-1)!, workspace.run.id].sort();
  expect(response.request().postDataJSON().arguments.run_ids.sort()).toEqual(expectedIds);
  expect(response.ok()).toBeTruthy();
  const generated = await response.json();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Результаты проверки", exact: true })).toBeVisible();
  const persisted = await api.call<{ snapshot: { runs: { id: string }[] } }>("get_report", workspace.project.id, { report_id: generated.id });
  expect(persisted.snapshot.runs.map(run => run.id).sort()).toEqual(expectedIds);
});
