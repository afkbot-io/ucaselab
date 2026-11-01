import { test, expect } from "./fixtures";
import type { Folder, UseCase } from "../src/types";

test("production v1 drafts remain copyable without title-based import or v2 overwrite", async ({ page, workspace, api }) => {
  const a = workspace.case;
  const b = await api.call<UseCase>("create_use_case", workspace.project.id, { content: { ...a.content, goal: "Серверный текст B" } });
  const open = async (id: string) => {
    await page.goto(`/p/${workspace.project.id}/cases/${id}`);
    await page.getByRole("button", { name: "Изменить", exact: true }).click();
  };
  await open(a.id);
  await page.getByLabel("Цель", { exact: true }).fill("Текущий черновик v2");
  await page.keyboard.press("Escape");
  const key = `ucaselab:draft:${workspace.identities.owner.id}:${workspace.project.id}:Редактирование юзер-кейса:${a.title}`;
  const legacy = { original: JSON.stringify(a.content), content: { ...a.content, goal: "Старый текст v1" }, folder: "", message: "Старая заметка" };
  const saved = await page.evaluate(({ key, legacy, owner, project }) => {
    const raw = JSON.stringify(legacy);
    sessionStorage.setItem(key, raw);
    sessionStorage.setItem(`ucaselab:draft:another-user:${project}:same`, JSON.stringify({ ...legacy, content: { ...legacy.content, goal: "Чужой текст" } }));
    sessionStorage.setItem(`ucaselab:draft:${owner}:another-project:same`, JSON.stringify({ ...legacy, content: { ...legacy.content, goal: "Другой проект" } }));
    sessionStorage.setItem(`ucaselab:draft:${owner}:${project}:unknown`, "unknown-stale-record");
    const v2 = Object.keys(sessionStorage).find((key) => key.startsWith("ucaselab:editor:v2:"))!;
    return { raw, v2, value: sessionStorage.getItem(v2) };
  }, { key, legacy, owner: workspace.identities.owner.id, project: workspace.project.id });
  await page.reload();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("Текущий черновик v2");
  const reveal = async () => {
    await page.getByText("Черновики предыдущей версии (1)", { exact: true }).click();
    await page.getByText(`Старый черновик 1: ${a.title}`, { exact: true }).click();
    await expect(page.getByRole("dialog").getByText("Старый текст v1", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Подготовить текст для копирования", exact: true }).click();
    const text = page.getByLabel("Текст старого черновика для копирования", { exact: true });
    await expect(text).toHaveValue(/Старый текст v1/);
    expect(await text.evaluate((el: HTMLTextAreaElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length)).toBe(true);
  };
  await reveal();
  await page.keyboard.press("Control+C");
  const clipboard = await page.context().newPage();
  try {
    await clipboard.setContent('<textarea aria-label="Проверка вставки"></textarea>');
    await clipboard.getByLabel("Проверка вставки", { exact: true }).focus();
    await clipboard.keyboard.press("Control+V");
    await expect(clipboard.getByLabel("Проверка вставки", { exact: true })).toHaveValue(/Старый текст v1/);
  } finally { await clipboard.close(); }
  await page.bringToFront();
  await expect(page.getByRole("dialog")).not.toContainText("Чужой текст");
  await expect(page.getByRole("dialog")).not.toContainText("Другой проект");
  expect(await page.evaluate(({ key, saved }) => ({ legacy: sessionStorage.getItem(key), v2: sessionStorage.getItem(saved.v2) }), { key, saved })).toEqual({ legacy: saved.raw, v2: saved.value });
  const goal = page.getByLabel("Цель", { exact: true });
  await goal.focus();
  await goal.press("End");
  await goal.pressSequentially(" — новый ввод", { delay: 10 });
  await expect(goal).toHaveValue("Текущий черновик v2 — новый ввод");
  await expect(goal).toBeFocused();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe(saved.raw);
  await page.keyboard.press("Escape");
  await open(b.id);
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("Серверный текст B");
  await page.keyboard.press("Escape");
  await api.call("save_use_case_draft", workspace.project.id, { use_case_id: a.id, expected_version: a.version, base_revision_id: a.revision_id, content: { ...a.content, goal: "Новая серверная ревизия" } });
  await open(a.id);
  await reveal();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe(saved.raw);
  expect(await page.evaluate(({ owner, project }) => sessionStorage.getItem(`ucaselab:draft:${owner}:${project}:unknown`), { owner: workspace.identities.owner.id, project: workspace.project.id })).toBe("unknown-stale-record");
});

test("starting over resets only this case to server values, folder and message", async ({ page, workspace, api }) => {
  const open = async (id: string) => {
    await page.goto(`/p/${workspace.project.id}/cases/${id}`);
    await page.getByRole("button", { name: "Изменить", exact: true }).click();
  };
  await open(workspace.draft.id);
  await page.getByLabel("Цель", { exact: true }).fill("Другой независимый черновик");
  await page.keyboard.press("Escape");
  const folder = await api.call<Folder>("create_folder", workspace.project.id, { name: "Папка для сброса" });
  await open(workspace.case.id);
  await page.getByLabel("Цель", { exact: true }).fill("Правка для удаления");
  await page.getByLabel("Что изменилось", { exact: true }).fill("Заметка для удаления");
  await page.getByRole("combobox", { name: "Папка", exact: true }).fill("Папка для сброса");
  await page.getByRole("option").filter({ has: page.locator("strong").filter({ hasText: /^Папка для сброса$/ }) }).click();
  const folderPicker = page.getByRole("dialog").locator(".picker").filter({ has: page.getByRole("combobox", { name: "Папка", exact: true }) });
  await expect(folderPicker.locator(".picker-chip")).toContainText("Папка для сброса");
  const draftKey = `ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, workspace.project.id, `case:edit:${workspace.case.id}`])}`;
  await expect.poll(() => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || "null")?.value.folder, draftKey)).toBe(folder.id);
  const preserved = {
    [`ucaselab:draft:${workspace.identities.owner.id}:${workspace.project.id}:legacy`]: JSON.stringify({ original: JSON.stringify(workspace.case.content), content: workspace.case.content, folder: "", message: "Старая запись" }),
    [`ucaselab:editor:v2:${JSON.stringify(["another-user", workspace.project.id, `case:edit:${workspace.case.id}`])}`]: "foreign-draft-record",
    [`ucaselab:draft:${workspace.identities.owner.id}:${workspace.project.id}:unknown`]: "unknown-legacy-record",
  };
  await page.evaluate((records) => Object.entries(records).forEach(([key, value]) => sessionStorage.setItem(key, value)), preserved);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByRole("button", { name: "Начать заново", exact: true }).click();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
  await expect(page.getByLabel("Что изменилось", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Название функционала", { exact: true })).toBeFocused();
  await expect(folderPicker.locator(".picker-chip")).toContainText("Без папки");
  expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
  await page.keyboard.press("Escape");
  await page.reload();
  expect(await page.evaluate((records) => Object.fromEntries(Object.keys(records).map((key) => [key, sessionStorage.getItem(key)])), preserved)).toEqual(preserved);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Начать заново", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await open(workspace.draft.id);
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("Другой независимый черновик");
});

test("starting over a new case returns to an empty draft after reload", async ({ page, workspace }) => {
  await page.goto(`/p/${workspace.project.id}/cases`);
  await page.getByRole("button", { name: "Новый юзер-кейс", exact: true }).click();
  await page.getByLabel("Название функционала", { exact: true }).fill("Новый локальный кейс");
  await page.getByLabel("Цель", { exact: true }).fill("Новый локальный текст");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Новый юзер-кейс", exact: true }).click();
  await page.getByRole("button", { name: "Начать заново", exact: true }).click();
  await expect(page.getByLabel("Название функционала", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Название функционала", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Цель", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Новый юзер-кейс", exact: true }).click();
  await expect(page.getByLabel("Название функционала", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Начать заново", exact: true })).toHaveCount(0);
});
