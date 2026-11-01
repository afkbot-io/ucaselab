import { test, expect } from "./fixtures";
import type { UseCase } from "../src/types";

test("same-title case drafts survive visiting a peer and a new server revision", async ({ page, workspace, api }) => {
  const a = workspace.case;
  const b = await api.call<UseCase>("create_use_case", workspace.project.id, {
    content: { ...a.content, goal: "Отдельный кейс B" },
  });
  const open = async (id: string) => {
    await page.goto(`/p/${workspace.project.id}/cases/${id}`);
    await page.getByRole("button", { name: "Изменить", exact: true }).click();
  };
  await open(a.id);
  await page.getByLabel("Цель", { exact: true }).fill("Локальная цель A");
  await page.keyboard.press("Escape");
  await open(b.id);
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("Отдельный кейс B");
  await page.keyboard.press("Escape");
  await open(a.id);
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("Локальная цель A");
  await page.keyboard.press("Escape");
  await api.call("save_use_case_draft", workspace.project.id, {
    use_case_id: a.id, expected_version: a.version, base_revision_id: a.revision_id,
    content: { ...a.content, goal: "Серверная цель A" }, message: "Параллельное изменение",
  });
  await open(a.id);
  await expect(page.getByText("Исходные данные изменились", { exact: false })).toBeVisible();
  await page.getByText("Текст при открытии", { exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Серверная цель A", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Восстановить локальный текст", exact: true }).click();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("Локальная цель A");
});

for (const closing of ["Escape", "button", "backdrop"] as const) {
  test(`proposal survives ${closing} and reload with title and description`, async ({ page, workspace }) => {
    await page.goto(`/p/${workspace.project.id}/proposals?new=1`);
    const form = page.getByRole("dialog", { name: "Новое предложение", exact: true });
    await form.getByLabel("Название предложения", { exact: true }).fill("Содержательное предложение");
    await form.getByLabel("Что нужно описать и проверить?", { exact: true }).fill("Сохранить все введённые поля");
    if (closing === "Escape") await page.keyboard.press("Escape");
    else if (closing === "button") await form.getByRole("button", { name: "Закрыть окно", exact: true }).click();
    else await page.mouse.click(2, 2);
    await expect(form).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "Новое предложение", exact: true }).click();
    await expect(form.getByLabel("Название предложения", { exact: true })).toHaveValue("Содержательное предложение");
    await expect(form.getByLabel("Что нужно описать и проверить?", { exact: true })).toHaveValue("Сохранить все введённые поля");
  });
}

test("prepared items with identical content have independent unfinished child drafts", async ({ page, workspace, api }) => {
  const proposal = await api.call<{ id: string }>("submit_proposal", workspace.project.id, {
    kind: "new_use_case", title: "Два одинаковых пункта", content: {
      description: "Изоляция вложенных редакторов",
      items: [0, 1].map(() => ({ action: "create_use_case", content: workspace.case.content })),
    },
  });
  await page.goto(`/p/${workspace.project.id}/proposals/${proposal.id}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const parent = page.getByRole("dialog", { name: "Изменить предложение", exact: true });
  const openItem = async (index: number) => parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).nth(index).click();
  await openItem(0);
  const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
  await child.getByLabel("Цель", { exact: true }).fill("Локальная правка первого пункта");
  await page.keyboard.press("Escape");
  await openItem(1);
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
  await child.getByLabel("Цель", { exact: true }).fill("Локальная правка второго пункта");
  await page.keyboard.press("Escape");
  await openItem(0);
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue("Локальная правка первого пункта");
  await child.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await openItem(0);
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue("Локальная правка первого пункта");
  await page.keyboard.press("Escape");
  await openItem(1);
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue("Локальная правка второго пункта");
});

test("invalid stored shapes do not crash the case editor", async ({ page, workspace }) => {
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Цель", { exact: true }).fill("Создать ключ черновика");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) => key.startsWith("ucaselab:editor:v2:"))!;
    const old = JSON.parse(sessionStorage.getItem(key)!);
    sessionStorage.setItem(key, JSON.stringify({ ...old, value: { content: { title: "Повреждённый", accounts: null } } }));
  });
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
  await expect(page.getByRole("button", { name: "Сохранить черновик", exact: true })).toBeVisible();
});

for (const closing of ["button", "backdrop"] as const) {
  test(`case draft survives ${closing}, failed save and subsequent successful save`, async ({ page, workspace }) => {
    await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
    const open = () => page.getByRole("button", { name: "Изменить", exact: true }).click();
    await open();
    const dialog = page.getByRole("dialog", { name: "Редактирование юзер-кейса", exact: true });
    await dialog.getByLabel("Цель", { exact: true }).fill("Черновик после обычного закрытия");
    if (closing === "button") await dialog.getByRole("button", { name: "Закрыть окно", exact: true }).click();
    else await page.mouse.click(2, 2);
    await open();
    await expect(dialog.getByLabel("Цель", { exact: true })).toHaveValue("Черновик после обычного закрытия");
    await page.route("**/api/actions/save_use_case_draft", (route) => route.fulfill({ status: 409, json: { detail: { code: "VERSION_CONFLICT", message: "Объект изменился. Сравните изменения" } } }));
    await dialog.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Объект изменился");
    await page.keyboard.press("Escape");
    await page.reload();
    await open();
    await expect(dialog.getByLabel("Цель", { exact: true })).toHaveValue("Черновик после обычного закрытия");
    await page.unroute("**/api/actions/save_use_case_draft");
    await dialog.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await open();
    await expect(dialog.getByLabel("Цель", { exact: true })).toHaveValue("Черновик после обычного закрытия");
    await expect(dialog.getByText("Вернули несохранённые изменения.", { exact: false })).toHaveCount(0);
  });
}

test("late successful save cannot delete new input from a reopened editor", async ({ page, workspace }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/actions/save_use_case_draft", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  const open = () => page.getByRole("button", { name: "Изменить", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Редактирование юзер-кейса", exact: true });
  try {
    await open();
    await dialog.getByLabel("Цель", { exact: true }).fill("Отправленный снимок");
    await dialog.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Сохраняем");
    await dialog.getByRole("button", { name: "Закрыть окно", exact: true }).click();
    await open();
    await dialog.getByLabel("Цель", { exact: true }).fill("Новый ввод во время запроса");
    const response = page.waitForResponse("**/api/actions/save_use_case_draft");
    release();
    await response;
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await open();
    await dialog.getByRole("button", { name: "Восстановить локальный текст", exact: true }).click();
    await expect(dialog.getByLabel("Цель", { exact: true })).toHaveValue("Новый ввод во время запроса");
  } finally { release(); }
});

test("case draft stays isolated after a same-tab user switch", async ({ page, workspace }) => {
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Цель", { exact: true }).fill("Личный черновик автора");
  await page.keyboard.press("Escape");
  // A fresh login changes this tab's user without revoking the shared setup session.
  // Keep sessionStorage intact so the test exercises draft identity isolation.
  await page.goto("/auth/login");
  await page.getByLabel("Электронная почта", { exact: true }).fill(workspace.identities.manager.email);
  await page.getByLabel("Пароль", { exact: true }).fill(workspace.identities.manager.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/auth\/login/);
  await page.goto(`/p/${workspace.project.id}/cases/${workspace.case.id}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
});

test("proposal target hydration cannot erase typing or lose the target after closing early", async ({ page, workspace }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/actions/get_use_case", async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(`/p/${workspace.project.id}/proposals?new=1&case=${workspace.case.id}`);
    const form = page.getByRole("dialog", { name: "Новое предложение", exact: true });
    await form.getByLabel("Название предложения", { exact: true }).fill("Текст до загрузки кейса");
    await form.getByLabel("Что нужно изменить и почему?", { exact: true }).fill("Описание до загрузки кейса");
    await page.keyboard.press("Escape");
    release();
    await page.goto(`/p/${workspace.project.id}/proposals?new=1&case=${workspace.case.id}`);
    await expect(form.getByLabel("Название предложения", { exact: true })).toHaveValue("Текст до загрузки кейса");
    await expect(form.getByLabel("Что нужно изменить и почему?", { exact: true })).toHaveValue("Описание до загрузки кейса");
    await expect(form.getByRole("button", { name: "Подготовить правки сценария", exact: true })).toBeEnabled();
    await expect(form.locator(".picker-chip")).toContainText(workspace.case.title);
  } finally { release(); }
});

test("an empty proposal retains its unfinished new child after both dialogs close and reload", async ({ page, workspace }) => {
  await page.goto(`/p/${workspace.project.id}/proposals?new=1`);
  const prepare = () => page.getByRole("button", { name: "Предложить шаги и данные", exact: true }).click();
  await prepare();
  const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
  await child.getByLabel("Название функционала", { exact: true }).fill("Незавершённый дочерний сценарий");
  await child.getByLabel("Цель", { exact: true }).fill("Текст без изменений в родительской форме");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Новое предложение", exact: true }).click();
  await prepare();
  await expect(child.getByLabel("Название функционала", { exact: true })).toHaveValue("Незавершённый дочерний сценарий");
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue("Текст без изменений в родительской форме");
});

test("copying a case does not borrow or clear the original local draft", async ({ page, workspace }) => {
  const original = `/p/${workspace.project.id}/cases/${workspace.case.id}`;
  await page.goto(original);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Цель", { exact: true }).fill("Несохранённая цель оригинала");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Другие действия", exact: true }).click();
  await page.getByRole("button", { name: "Скопировать", exact: true }).click();
  const copy = page.getByRole("dialog", { name: "Копия юзер-кейса", exact: true });
  await copy.getByLabel("Название нового кейса", { exact: true }).fill(workspace.case.title);
  await copy.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`${workspace.case.id}$`));
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
  await page.keyboard.press("Escape");
  await page.goto(original);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("Несохранённая цель оригинала");
});

test("target label arriving during proposal submission does not retain the submitted draft", async ({ page, workspace }) => {
  let releaseLabel!: () => void;
  let releaseSubmit!: () => void;
  const labelHeld = new Promise<void>((resolve) => { releaseLabel = resolve; });
  const submitHeld = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  await page.route("**/api/actions/get_use_case", async (route) => { await labelHeld; await route.continue(); });
  await page.route("**/api/actions/submit_proposal", async (route) => { await submitHeld; await route.continue(); });
  try {
    const url = `/p/${workspace.project.id}/proposals?new=1&case=${workspace.case.id}`;
    await page.goto(url);
    const form = page.getByRole("dialog", { name: "Новое предложение", exact: true });
    await form.getByLabel("Название предложения", { exact: true }).fill("Отправляемый текст");
    await form.getByLabel("Что нужно изменить и почему?", { exact: true }).fill("Отправляемое описание");
    await form.getByRole("button", { name: "Отправить на рассмотрение", exact: true }).click();
    await expect(form.getByRole("status")).toContainText("Сохраняем");
    releaseLabel();
    await expect(form.locator(".picker-chip")).toContainText(workspace.case.title);
    releaseSubmit();
    await expect(form).toHaveCount(0);
    await page.goto(url);
    await expect(form.getByLabel("Название предложения", { exact: true })).toHaveValue("");
    await expect(form.getByLabel("Что нужно изменить и почему?", { exact: true })).toHaveValue("");
  } finally { releaseLabel(); releaseSubmit(); }
});
