import { test, expect, expectNoOverflow } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`long case keeps save and focused fields visible in ${theme}`, async ({ page, workspace, api }, info) => {
    await api.profile({ theme });
    const c = workspace.case;
    await api.call("save_use_case_draft", workspace.project.id, {
      use_case_id: c.id, expected_version: c.version, base_revision_id: c.revision_id,
      content: { ...c.content, steps: Array.from({ length: 12 }, (_, i) => ({ key: `step${i}`, action: `Длинное действие ${i + 1}: подготовить данные и проверить состояние интерфейса`, expected: "Ожидаемый результат отображается пользователю" })) },
    });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
      await page.goto(`/p/${workspace.project.id}/cases/${c.id}`);
      await page.getByRole("button", { name: "Изменить", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Редактирование юзер-кейса", exact: true });
      const save = dialog.getByRole("button", { name: "Сохранить черновик", exact: true });
      const before = await save.boundingBox();
      expect(before!.y).toBeGreaterThan(0);
      expect(before!.y + before!.height).toBeLessThan(page.viewportSize()!.height);
      await dialog.getByLabel("Очистка после выполнения", { exact: true }).focus();
      const cleanup = await dialog.getByLabel("Очистка после выполнения", { exact: true }).boundingBox();
      const after = await save.boundingBox();
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
      expect(cleanup!.y + cleanup!.height).toBeLessThan(after!.y);
      await page.screenshot({ path: info.outputPath(`long-editor-${width}-${theme}.png`) });
      await page.keyboard.press("Escape");
    }
  });

  test(`populated mobile library starts with useful results and preserves root semantics in ${theme}`, async ({ page, workspace, api }, info) => {
    await api.profile({ theme });
    await api.call("update_project", workspace.project.id, {
      expected_version: workspace.project.version,
      name: "Проверка пользовательских сценариев корпоративной платформы управления доступом и восстановления учётных записей сотрудников",
      description: "Длинный контекст проекта не должен вытеснять результаты библиотеки",
    });
    for (const [width, height] of [[320, 640], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`/p/${workspace.project.id}/cases`);
      const first = page.locator(".case-title-link").first();
      await expect(first).toBeVisible();
      const rect = await first.boundingBox();
      expect(rect!.y + Math.min(rect!.height, 40)).toBeLessThan(height);
      await expect(page.getByRole("button", { name: "Убрать Все юзер-кейсы", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Новый юзер-кейс", exact: true })).toBeVisible();
      await expectNoOverflow(page);
      await page.screenshot({ path: info.outputPath(`populated-library-${width}-${theme}.png`) });
      await page.locator(".library-mobile-actions > summary").click();
      await expect(page.getByRole("button", { name: "Удалённые папки", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Архив кейсов", exact: true })).toBeVisible();
    }
  });
}
