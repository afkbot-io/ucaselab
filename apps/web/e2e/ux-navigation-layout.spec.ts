import { test, expect } from "./fixtures";

test("settings URLs restore every real tab and browser history", async ({ page, workspace }) => {
  await page.goto(`/p/${workspace.project.id}/settings`);
  for (const [key, label] of [["team", "Команда"], ["environments", "Окружения"], ["guide", "Инструкции ИИ"], ["notifications", "Уведомления"], ["audit", "Аудит"], ["general", "Общее"]]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`tab=${key}`));
    await page.reload();
    await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Аудит", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.getByRole("tab", { name: "Общее", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto(`/p/${workspace.project.id}/settings?tab=unknown`);
  await expect(page.getByRole("tab", { name: "Общее", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("avatar and explicit MCP navigation preserve distinct intent including global redirect", async ({ page, workspace }) => {
  await page.goto(`/p/${workspace.project.id}/cases`);
  await page.locator(".topbar .avatar").click();
  await expect(page.locator(".sidebar a[href$=\"profile?tab=mcp\"]")).not.toHaveClass(/active/);
  await expect(page.getByRole("tab", { name: "Профиль", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto("/profile?tab=skills");
  await expect(page.getByRole("tab", { name: "Навыки для агента", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto(`/p/${workspace.project.id}/profile?tab=mcp`);
  await expect(page.getByRole("tab", { name: "MCP-доступ", exact: true })).toHaveAttribute("aria-selected", "true");
});

for (const theme of ["light", "dark"] as const) {
  test(`library headers follow content at tablet boundaries in ${theme}`, async ({ page, workspace, api }) => {
    await api.profile({ theme });
    for (const width of [760, 768, 1024, 1200, 1201]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ["cases", "specifications", "accounts"]) {
        await page.goto(`/p/${workspace.project.id}/${route}`);
        const heading = page.locator(".page-heading");
        await expect(heading).toBeVisible();
        const geometry = await heading.evaluate((el) => {
          const children = [...el.children].map((child) => child.getBoundingClientRect());
          return { height: el.getBoundingClientRect().height, content: Math.max(...children.map((r) => r.bottom)) - Math.min(...children.map((r) => r.top)) };
        });
        expect(geometry.height - geometry.content, `${route} ${width}`).toBeLessThan(10);
      }
    }
  });
  test(`proposal title keeps useful line width on mobile in ${theme}`, async ({ page, workspace, api }, info) => {
    await api.profile({ theme });
    const title = "Уточнить восстановление доступа при повторном запросе подтверждения электронной почты";
    await api.call("submit_proposal", workspace.project.id, { kind: "new_use_case", title, content: { description: "Синтетическое длинное предложение" } });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/p/${workspace.project.id}/proposals`);
      const row = page.getByRole("link").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      const rect = await row.getByRole("heading").boundingBox();
      expect(rect!.width).toBeGreaterThan(width * 0.6);
      expect(rect!.height).toBeLessThan(140);
      await expect(row.getByText("На рассмотрении", { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`proposals-${width}-${theme}.png`) });
    }
  });
}
