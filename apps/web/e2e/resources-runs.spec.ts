import fs from "node:fs/promises";
import { test, expect, expectNoOverflow } from "./fixtures";
import type { Specification, Account, Run, UseCase } from "../src/types";

test("specifications are created, edited and linked through the case editor", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/specifications`);
  await page
    .getByRole("button", { name: "Новая спецификация", exact: true })
    .click();
  await page
    .getByLabel("Название спецификации", { exact: true })
    .fill("Сессия после выхода");
  await page
    .getByLabel("Описание", { exact: true })
    .fill("После выхода закрытые страницы недоступны.");
  await page
    .getByLabel("Критерии приёмки", { exact: true })
    .fill("Повторное открытие профиля требует входа.");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const specs = await workspace.apis.owner.call<{ items: Specification[] }>(
    "list_specifications",
    pid,
    { search: "Сессия после выхода" },
  );
  expect(specs.items).toHaveLength(1);
  await page.goto(`/p/${pid}/cases/${workspace.draft.id}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const picker = page.getByRole("combobox", {
    name: "Спецификации",
    exact: true,
  });
  await picker.fill("Сессия после выхода");
  await page.getByRole("option", { name: /Сессия после выхода/ }).click();
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const c = await workspace.apis.owner.call<UseCase>("get_use_case", pid, {
    use_case_id: workspace.draft.id,
  });
  expect(
    c.content.specifications.some(
      (s) => s.specification_id === specs.items[0].id,
    ),
  ).toBeTruthy();
});

test("account metadata and secret are saved separately, then the account can be archived", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/accounts`);
  await page
    .getByRole("button", { name: "Новый аккаунт", exact: true })
    .click();
  await page
    .getByLabel("Название аккаунта", { exact: true })
    .fill("Подтверждённый пользователь");
  await page
    .getByLabel("Логин", { exact: true })
    .fill("synthetic@example.invalid");
  await page
    .getByLabel("Описание", { exact: true })
    .fill("Синтетический аккаунт UI-теста.");
  await page
    .getByLabel("Пароль аккаунта", { exact: true })
    .fill("Synthetic-test-secret");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const accounts = await workspace.apis.owner.call<{ items: Account[] }>(
    "list_test_accounts",
    pid,
    { search: "Подтверждённый пользователь" },
  );
  expect(accounts.items).toHaveLength(1);
  expect(accounts.items[0].has_secret).toBeTruthy();
  expect(JSON.stringify(accounts)).not.toContain("Synthetic-test-secret");
  const secret = await workspace.apis.owner.call<{ secret: string }>(
    "reveal_test_account_secret",
    pid,
    {
      account_id: accounts.items[0].id,
      reason: "Проверка разделения хранения в UI-тесте",
    },
  );
  expect(secret.secret).toBe("Synthetic-test-secret");
  await workspace.apis.owner.call("archive_test_account", pid, {
    object_id: accounts.items[0].id,
    expected_version: accounts.items[0].version,
  });
  expect(
    (
      await workspace.apis.owner.call<{ items: Account[] }>(
        "list_test_accounts",
        pid,
      )
    ).items,
  ).toHaveLength(0);
});

test("readiness, step results, final outcomes and report downloads form one complete workflow", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/runs/${workspace.run.id}`);
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
    .getByLabel("Пояснение к подготовке", { exact: true })
    .fill("Изолированный UI-тест рабочего процесса UCaseLab.");
  await page
    .getByRole("button", { name: "Сохранить подготовку", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Начать проверку", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Начать проверку", exact: true })
    .click();
  for (let variant = 0; variant < 2; variant++) {
    if (variant)
      await page
        .getByRole("button", { name: "Начать проверку", exact: true })
        .click();
    const steps = page.getByRole("button", { name: "Совпало", exact: true });
    await expect(steps).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await steps.nth(i).click();
      await expect(steps.nth(i)).toHaveAttribute("aria-pressed", "true");
    }
    await page
      .getByRole("button", { name: "Записать результат", exact: true })
      .click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("radio", { name: /Всё совпало/ }).check();
    await modal
      .getByLabel("Что подтвердили при проверке?", { exact: true })
      .fill("Синтетический результат UI-теста: шаги и данные сохранены.");
    await modal
      .getByRole("button", {
        name: variant ? "Сохранить результат" : "Сохранить и перейти дальше",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page
    .getByRole("button", { name: "Завершить прогон", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Завершить прогон", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Создать отчёт", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("textbox")
    .first()
    .fill("Результаты UI-регрессии");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Создать отчёт", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Результаты UI-регрессии", exact: true }),
  ).toBeVisible();
  await expectNoOverflow(page);
  const reportURL = page.url();
  for (const format of ["PDF", "CSV", "JSON"]) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: format, exact: true }).click();
    const downloaded = await downloadPromise;
    expect(downloaded.suggestedFilename()).toMatch(
      new RegExp(`^report-.+\\.${format.toLowerCase()}$`),
    );
    const bytes = await fs.readFile((await downloaded.path())!);
    expect(bytes.length).toBeGreaterThan(100);
    await expect(page).toHaveURL(reportURL);
    await expect(
      page.getByRole("heading", { name: "Результаты UI-регрессии", exact: true }),
    ).toBeVisible();
    if (format === "CSV")
      expect(bytes.toString()).toContain("Синтетический результат UI-теста");
    if (format === "PDF") expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    if (format === "JSON")
      expect(JSON.stringify(JSON.parse(bytes.toString()))).toContain(
        "Синтетический результат UI-теста",
      );
  }
  const final = await workspace.apis.owner.call<Run>("get_run", pid, {
    run_id: workspace.run.id,
  });
  expect(final.status).toBe("completed");
  expect(final.summary.counts.passed).toBe(2);
});

test("draft checks can be prepared through the UI without publishing the source", async ({
  page,
  workspace,
}) => {
  const pid = workspace.project.id;
  await page.goto(`/p/${pid}/cases/${workspace.draft.id}`);
  await page.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("combobox", {
      name: "Какие версии проверяем?",
      exact: true,
    }),
  ).toHaveValue("draft");
  await page
    .getByLabel("Окружение", { exact: true })
    .selectOption(workspace.env.id);
  await page
    .getByLabel("Название прогона", { exact: true })
    .fill("Проверка рабочего черновика");
  await expectNoOverflow(page);
  await page
    .getByRole("button", { name: "Подготовить прогон", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Проверка рабочего черновика",
      exact: true,
    }),
  ).toBeVisible();
  const runId = page.url().split("/runs/")[1];
  const run = await workspace.apis.owner.call<Run>("get_run", pid, {
    run_id: runId,
  });
  expect(run.case_source).toBe("draft");
  const source = await workspace.apis.owner.call<UseCase>("get_use_case", pid, {
    use_case_id: workspace.draft.id,
  });
  expect(source.current_publication_id).toBeNull();
});

for (const outcome of [
  {
    status: "failed",
    step: "Ошибка приложения",
    radio: "Ошибка приложения",
    field: "Что произошло и чем отличается от подтверждённого ожидания?",
    actual:
      "Приложение вернуло 500 вместо результата. Синтетическая проверка записи.",
  },
  {
    status: "scenario_issue",
    step: "Уточнить сценарий",
    radio: "Неточность сценария",
    field: "Что нужно уточнить в сценарии и что вы наблюдали?",
    actual:
      "В сценарии не указан обязательный выбор типа профиля. Синтетическая проверка записи.",
  },
  {
    status: "blocked",
    step: "Не могу проверить",
    radio: "Не удалось проверить",
    field: "Что помешало выполнить проверку?",
    actual: "Тестовый стенд недоступен. Синтетическая проверка записи.",
  },
] as const) {
  test(`execution outcome ${outcome.status} has a distinct, readable result`, async ({
    page,
    workspace,
  }) => {
    const pid = workspace.project.id;
    await workspace.apis.owner.call("confirm_run_readiness", pid, {
      run_id: workspace.run.id,
      expected_version: workspace.run.version,
      checks: {
        environment: "ready",
        accounts: "not_required",
        dependencies: "not_required",
      },
      notes: "Синтетическая проверка формы результатов.",
    });
    await page.goto(`/p/${pid}/runs/${workspace.run.id}`);
    await page
      .getByRole("button", { name: "Начать проверку", exact: true })
      .click();
    await page
      .getByRole("button", { name: outcome.step, exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Записать результат", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("radio", { name: new RegExp(outcome.radio) })
      .check();
    await dialog
      .getByLabel(outcome.field, { exact: true })
      .fill(outcome.actual);
    await expectNoOverflow(page);
    await dialog
      .getByRole("button", { name: "Сохранить и перейти дальше", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const run = await workspace.apis.owner.call<Run>("get_run", pid, {
      run_id: workspace.run.id,
    });
    expect(run.summary.counts[outcome.status]).toBe(1);
    expect(JSON.stringify(run)).toContain(outcome.actual);
    expect(run.summary.counts.passed).toBe(0);
  });
}
