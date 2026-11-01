import { test, expect, expectNoOverflow } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`specification titles and tags remain readable beside navigation in ${theme}`, async ({ page, workspace, api }, info) => {
    await api.profile({ theme });
    const title = "Согласованное поведение восстановления доступа при повторном запросе";
    const tag = "Длинная метка требования для проверки таблиц";
    await api.call("create_specification", workspace.project.id, {
      title,
      tags: [tag],
      description: "Синтетическая проверка читаемости таблицы с боковой навигацией и деревом папок.",
      acceptance_criteria: "Название и метка читаются обычными строками; прокрутка остаётся внутри таблицы.",
    });
    for (const width of [768, 320, 390, 760, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/p/${workspace.project.id}/specifications`);
      const name = page.getByRole("button", { name: title, exact: true });
      await expect(name).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const row = page.getByRole("row").filter({ has: name });
      const label = width > 760
        ? row.locator("td:nth-child(2) .tag").filter({ hasText: tag })
        : row.locator(".spec-mobile-meta .tag").filter({ hasText: tag });
      await expect(label).toBeVisible();
      const labelBox = await label.boundingBox();
      const titleBox = await name.boundingBox();
      expect(labelBox!.width, `tag readable width at ${width}`).toBeGreaterThan(130);
      expect(labelBox!.height, `tag readable height at ${width}`).toBeLessThan(80);
      expect(titleBox!.width, `title readable width at ${width}`).toBeGreaterThan(160);
      expect(titleBox!.height, `title readable height at ${width}`).toBeLessThan(150);
      expect((await row.boundingBox())!.height, `row readable height at ${width}`).toBeLessThan(250);
      await expectNoOverflow(page);
      const scroller = page.locator(".table-scroll").filter({ has: row });
      const scroll = await scroller.evaluate((el) => ({ client: el.clientWidth, content: el.scrollWidth }));
      if (width === 768) expect(scroll.content - scroll.client).toBeGreaterThan(100);
      await info.attach(`readability-${width}-${theme}`, {
        body: JSON.stringify({ width, theme, tag: labelBox, title: titleBox, row: await row.boundingBox(), scroll }),
        contentType: "application/json",
      });
      await row.screenshot({ path: info.outputPath(`specification-row-${width}-${theme}.png`) });
      // An offscreen edit action must remain reachable through the table scroller.
      await row.getByRole("button", { name: `Изменить спецификацию «${title}»`, exact: true }).scrollIntoViewIfNeeded();
      if (width === 768) {
        expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.scrollX)).toBe(0);
      }
      await row.getByRole("button", { name: `Изменить спецификацию «${title}»`, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });
}
