import { test, expect } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });
for (const emailEnabled of [false, true]) {
  for (const flow of ["verify", "link", "reset"]) {
    test(`damaged and invalid ${flow} links explain recovery with email=${emailEnabled}`, async ({ page }, info) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.route("**/api/auth/config", (route) => route.fulfill({ json: { email_enabled: emailEnabled } }));
      for (const token of ["short", "synthetic-invalid-link-000000000000"]) {
        await page.goto(`/auth/${flow}?token=${token}`);
        if (flow === "reset") {
          await page.getByLabel("Новый пароль", { exact: true }).fill("synthetic-reset-password");
          await page.getByRole("button", { name: "Сохранить пароль", exact: true }).click();
        }
        const error = page.locator(".error");
        await expect(error).toContainText("Ссылка повреждена, уже использована или срок её действия истёк.");
        await expect(error).not.toContainText(token);
        await expect(error).not.toContainText("body.token");
        await expect(error).not.toContainText("String should");
        if (flow !== "reset") {
          const reason = error.locator("span").first();
          const box = await reason.boundingBox();
          expect(box!.width).toBeGreaterThan(180);
          if (token === "short") await page.screenshot({ path: info.outputPath(`auth-${flow}-email-${emailEnabled}.png`) });
        }
        if (!emailEnabled) await expect(error).toContainText("Отправка писем отключена");
        else await expect(page.getByRole("link", { name: "Запросить новую ссылку", exact: true })).toBeVisible();
      }
    });
  }
}

test("reset password validation is not reported as a damaged link", async ({ page }) => {
  await page.route("**/api/auth/config", (route) => route.fulfill({ json: { email_enabled: true } }));
  await page.route("**/api/auth/consume", (route) => route.fulfill({ status: 422, json: { detail: {
    code: "VALIDATION_ERROR", message: "body.password: String should have at least 10 characters",
  } } }));
  await page.goto("/auth/reset?token=synthetic-valid-format-reset-token");
  await page.getByLabel("Новый пароль", { exact: true }).fill("😀😀😀😀😀");
  await page.getByRole("button", { name: "Сохранить пароль", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Пароль должен содержать от 10 до 128 символов");
  await expect(page.getByRole("alert")).not.toContainText("Ссылка повреждена");
  // Also exercise the server field-specific validation branch, with native-valid input.
  await page.getByLabel("Новый пароль", { exact: true }).fill("synthetic-long-enough-password");
  await page.getByRole("button", { name: "Сохранить пароль", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Пароль должен содержать от 10 до 128 символов");
  await expect(page.getByRole("alert")).not.toContainText("Ссылка повреждена");
});
