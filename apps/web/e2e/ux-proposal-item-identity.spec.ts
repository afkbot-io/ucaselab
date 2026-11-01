import { test, expect } from "./fixtures";
import type { Proposal } from "../src/types";

for (const survivorPending of [false, true]) {
test(`deleting a prepared peer preserves remaining item identity after save/reload (pending=${survivorPending})`, async ({ page, workspace, api }, info) => {
  const proposal = await api.call<{ id: string }>("submit_proposal", workspace.project.id, {
    kind: "new_use_case", title: "Проверка идентичности пунктов после удаления", content: {
      description: "Два одинаковых пункта с отдельными локальными изменениями",
      items: [0, 1].map(() => ({ action: "create_use_case", content: workspace.case.content })),
    },
  });
  await page.goto(`/p/${workspace.project.id}/proposals/${proposal.id}`);
  const edit = () => page.getByRole("button", { name: "Изменить", exact: true }).click();
  await edit();
  const parent = page.getByRole("dialog", { name: "Изменить предложение", exact: true });
  const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
  await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).nth(0).click();
  await child.getByLabel("Цель", { exact: true }).fill("Локальный текст удалённого первого пункта");
  await page.keyboard.press("Escape");
  if (survivorPending) {
    await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).nth(1).click();
    await child.getByLabel("Цель", { exact: true }).fill("Собственный черновик оставшегося пункта");
    await page.keyboard.press("Escape");
  }
  const removed = await page.evaluate(() => Object.entries(sessionStorage).find(([, raw]) => raw.includes("Локальный текст удалённого первого пункта")));
  expect(removed).toBeTruthy();
  await parent.getByRole("button", { name: "Убрать предложенный сценарий", exact: true }).nth(0).click();
  await expect(parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true })).toHaveCount(1);
  await parent.getByRole("button", { name: "Сохранить предложение", exact: true }).click();
  await expect(parent).toHaveCount(0);
  await page.reload();
  await edit();
  await parent.getByText("Несвязанные черновики сценариев (1)", { exact: true }).click();
  await parent.getByText(`Старый черновик 1: ${workspace.case.title}`, { exact: true }).click();
  await expect(parent.getByText("Локальный текст удалённого первого пункта", { exact: false })).toBeVisible();
  await parent.getByRole("button", { name: "Подготовить текст для копирования", exact: true }).click();
  await expect(parent.getByLabel("Текст старого черновика для копирования", { exact: true })).toHaveValue(/Локальный текст удалённого/);
  const parentTitle = parent.getByLabel("Название предложения", { exact: true });
  await parentTitle.focus();
  await parentTitle.press("End");
  await parentTitle.pressSequentially(" — новый ввод");
  await expect(parentTitle).toBeFocused();
  await expect(parentTitle).toHaveValue("Проверка идентичности пунктов после удаления — новый ввод");
  await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
  await info.attach("observed-child", { body: JSON.stringify({ expected: workspace.case.content.goal, observed: await child.getByLabel("Цель", { exact: true }).inputValue() }), contentType: "application/json" });
  await child.screenshot({ path: info.outputPath("remaining-item-editor.png") });
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue(survivorPending ? "Собственный черновик оставшегося пункта" : workspace.case.content.goal);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), removed![0])).toBe(removed![1]);
});

}

test("an external revision quarantines ambiguous children without deleting their input", async ({ page, workspace, api }) => {
  const p = await api.call<Proposal>("submit_proposal", workspace.project.id, {
    kind: "new_use_case", title: "Внешняя ревизия пунктов", content: {
      description: "Два одинаковых серверных пункта",
      items: [0, 1].map(() => ({ action: "create_use_case", content: workspace.case.content })),
    },
  });
  await page.goto(`/p/${workspace.project.id}/proposals/${p.id}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const parent = page.getByRole("dialog", { name: "Изменить предложение", exact: true });
  const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
  for (const index of [0, 1]) {
    await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).nth(index).click();
    await child.getByLabel("Цель", { exact: true }).fill(`Несохранённый пункт ${index}`);
    await page.keyboard.press("Escape");
  }
  const records = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([, raw]) => raw.includes("Несохранённый пункт"))));
  await page.keyboard.press("Escape");
  await api.call("update_proposal", workspace.project.id, {
    proposal_id: p.id, expected_version: p.version, title: p.title,
    content: { ...p.content, items: [p.content.items[1]] },
  });
  await page.reload();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await parent.getByText("Несвязанные черновики сценариев (2)", { exact: true }).click();
  await expect(parent.getByText(`Старый черновик 1: ${workspace.case.title}`, { exact: true })).toBeVisible();
  await expect(parent.getByText(`Старый черновик 2: ${workspace.case.title}`, { exact: true })).toBeVisible();
  await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
  expect(await page.evaluate((records) => Object.fromEntries(Object.keys(records).map((key) => [key, sessionStorage.getItem(key)])), records)).toEqual(records);
});

test("old positional child drafts remain copyable but are never assigned by index", async ({ page, workspace, api }) => {
  const p = await api.call<Proposal>("submit_proposal", workspace.project.id, {
    kind: "new_use_case", title: "Старый позиционный черновик", content: {
      description: "Безопасное открытие прежнего формата",
      items: [{ action: "create_use_case", content: workspace.case.content }],
    },
  });
  await page.goto(`/p/${workspace.project.id}/proposals/${p.id}`);
  const key = `ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, workspace.project.id, `proposal:${p.id}:item:existing:0`])}`;
  const value = JSON.stringify({ base: JSON.stringify([null, workspace.case.content, ""]), value: { content: { ...workspace.case.content, goal: "Прежний позиционный ввод" }, folder: "", message: "" } });
  const records = {
    [key]: value,
    [`ucaselab:editor:v2:${JSON.stringify(["another-user", workspace.project.id, `proposal:${p.id}:item:existing:0`])}`]: value.replace("Прежний позиционный ввод", "Чужой ввод"),
    [`ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, "another-project", `proposal:${p.id}:item:existing:0`])}`]: value.replace("Прежний позиционный ввод", "Другой проект"),
    [`ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, workspace.project.id, `proposal:${p.id}:item:unknown`])}`]: "unknown-record",
  };
  await page.evaluate((records) => Object.entries(records).forEach(([key, raw]) => sessionStorage.setItem(key, raw)), records);
  await page.reload();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const parent = page.getByRole("dialog", { name: "Изменить предложение", exact: true });
  await parent.getByText("Несвязанные черновики сценариев (1)", { exact: true }).click();
  await parent.getByText(`Старый черновик 1: ${workspace.case.title}`, { exact: true }).click();
  await expect(parent.getByText("Прежний позиционный ввод", { exact: false })).toBeVisible();
  await expect(parent).not.toContainText("Чужой ввод");
  await expect(parent).not.toContainText("Другой проект");
  await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
  const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
  expect(await page.evaluate((records) => Object.fromEntries(Object.keys(records).map((key) => [key, sessionStorage.getItem(key)])), records)).toEqual(records);
});

test("a new proposal carries its known child's pending input to the assigned server ID", async ({ page, workspace }) => {
  await page.goto(`/p/${workspace.project.id}/proposals?new=1`);
  const parent = page.getByRole("dialog", { name: "Новое предложение", exact: true });
  const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
  await parent.getByLabel("Название предложения", { exact: true }).fill("Переход к серверному ID");
  await parent.getByLabel("Что нужно описать и проверить?", { exact: true }).fill("Сохранить незавершённую дочернюю правку");
  await parent.getByRole("button", { name: "Предложить шаги и данные", exact: true }).click();
  await child.getByLabel("Цель", { exact: true }).fill("Подготовленный текст");
  await child.getByLabel("Действие", { exact: true }).fill("Открыть приложение");
  await child.getByLabel("Ожидаемый результат", { exact: true }).fill("Приложение открыто");
  await child.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
  await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
  await child.getByLabel("Цель", { exact: true }).fill("Поздний ввод до получения ID предложения");
  await page.keyboard.press("Escape");
  await parent.getByRole("button", { name: "Отправить на рассмотрение", exact: true }).click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f-]+$/);
  await page.reload();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const savedParent = page.getByRole("dialog", { name: "Изменить предложение", exact: true });
  await savedParent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
  await expect(child).toBeVisible();
  // Server normalization may change the base. Recovery must remain explicit then.
  const recover = child.getByRole("button", { name: "Восстановить локальный текст", exact: true });
  if (await recover.count()) await recover.click();
  await expect(child.getByLabel("Цель", { exact: true })).toHaveValue("Поздний ввод до получения ID предложения");
});

test("a late parent response keeps submitted IDs separate from newly reopened input", async ({ page, workspace, api }) => {
  const p = await api.call<Proposal>("submit_proposal", workspace.project.id, {
    kind: "new_use_case", title: "Поздний ответ родителя", content: {
      description: "Сохранение снимка не удаляет новый состав",
      items: [0, 1].map(() => ({ action: "create_use_case", content: workspace.case.content })),
    },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/actions/update_proposal", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const parent = page.getByRole("dialog", { name: "Изменить предложение", exact: true });
  const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
  const edit = () => page.getByRole("button", { name: "Изменить", exact: true }).click();
  try {
    await page.goto(`/p/${workspace.project.id}/proposals/${p.id}`);
    await edit();
    await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).nth(1).click();
    await child.getByLabel("Цель", { exact: true }).fill("Незавершённый текст B во время родительского запроса");
    await page.keyboard.press("Escape");
    await parent.getByRole("button", { name: "Сохранить предложение", exact: true }).click();
    await expect(parent.getByRole("status")).toContainText("Сохраняем");
    await parent.getByRole("button", { name: "Закрыть окно", exact: true }).click();
    await edit();
    await parent.getByRole("button", { name: "Убрать предложенный сценарий", exact: true }).nth(0).click();
    const response = page.waitForResponse("**/api/actions/update_proposal");
    release();
    await response;
    await expect(parent).toHaveCount(0);
    await page.reload();
    await edit();
    await parent.getByRole("button", { name: "Восстановить локальный текст", exact: true }).click();
    await expect(parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true })).toHaveCount(1);
    await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
    await expect(child.getByLabel("Цель", { exact: true })).toHaveValue("Незавершённый текст B во время родительского запроса");
  } finally { release(); }
});

for (const oldId of ["existing:0", "obsolete-item"]) {
  test(`a same-base legacy parent preserves authored text without adopting child identity ${oldId}`, async ({ page, workspace, api }) => {
    const created = await api.call<Proposal>("submit_proposal", workspace.project.id, {
      kind: "new_use_case", title: "Оставшийся пункт B", content: {
        description: "Серверный текст после прежнего удаления",
        items: [{ action: "create_use_case", content: workspace.case.content }],
      },
    });
    const p = await api.call<Proposal>("get_proposal", workspace.project.id, { proposal_id: created.id });
    await page.goto(`/p/${workspace.project.id}/proposals/${p.id}`);
    const context = `proposal:${p.id}`;
    const parentKey = `ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, workspace.project.id, context])}`;
    const childKey = `ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, workspace.project.id, `${context}:item:${oldId}`])}`;
    const childValue = JSON.stringify({ base: JSON.stringify([null, p.content.items[0].content, ""]), value: { content: { ...workspace.case.content, goal: "Прежний ввод удалённого A" }, folder: "", message: "" } });
    const parentValue = JSON.stringify({ base: JSON.stringify(p), value: {
      title: "Авторский заголовок родителя", kind: p.kind, description: "Сохранить авторское описание родителя",
      target: [], repository: "", sha: "", pr: "", fingerprint: "", impact: "unknown",
      items: p.content.items, itemIds: [oldId], newItemId: crypto.randomUUID(),
    } });
    const untouched = {
      [childKey]: childValue,
      [`ucaselab:editor:v2:${JSON.stringify(["another-user", workspace.project.id, `${context}:item:${oldId}`])}`]: childValue.replace("Прежний ввод удалённого A", "Чужой ввод"),
      [`ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, "another-project", `${context}:item:${oldId}`])}`]: childValue.replace("Прежний ввод удалённого A", "Другой проект"),
      [`ucaselab:editor:v2:${JSON.stringify([workspace.identities.owner.id, workspace.project.id, `${context}:item:unknown`])}`]: "unknown-record",
    };
    await page.evaluate(({ parentKey, parentValue, untouched }) => {
      sessionStorage.setItem(parentKey, parentValue);
      Object.entries(untouched).forEach(([key, raw]) => sessionStorage.setItem(key, raw));
    }, { parentKey, parentValue, untouched });
    await page.reload();
    await page.getByRole("button", { name: "Изменить", exact: true }).click();
    const parent = page.getByRole("dialog", { name: "Изменить предложение", exact: true });
    await expect(parent.getByLabel("Название предложения", { exact: true })).toHaveValue("Авторский заголовок родителя");
    await expect(parent.getByLabel("Что нужно описать и проверить?", { exact: true })).toHaveValue("Сохранить авторское описание родителя");
    await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
    const child = page.getByRole("dialog", { name: "Предложить новый сценарий", exact: true });
    await expect(child.getByLabel("Цель", { exact: true })).toHaveValue(workspace.case.content.goal);
    await page.keyboard.press("Escape");
    await parent.getByText("Несвязанные черновики сценариев (1)", { exact: true }).click();
    await parent.getByText(`Старый черновик 1: ${workspace.case.title}`, { exact: true }).click();
    await expect(parent.getByText("Прежний ввод удалённого A", { exact: false })).toBeVisible();
    await expect(parent).not.toContainText("Чужой ввод");
    await expect(parent).not.toContainText("Другой проект");
    expect(await page.evaluate((records) => Object.fromEntries(Object.keys(records).map((key) => [key, sessionStorage.getItem(key)])), untouched)).toEqual(untouched);
    const migrated = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).value, parentKey);
    expect(migrated.itemIds[0]).not.toBe(oldId);
    expect(migrated.description).toBe("Сохранить авторское описание родителя");
    await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
    await child.getByLabel("Цель", { exact: true }).fill("Собственный ввод B после миграции");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("button", { name: "Изменить", exact: true }).click();
    await expect(parent.getByLabel("Что нужно описать и проверить?", { exact: true })).toHaveValue("Сохранить авторское описание родителя");
    await parent.getByRole("button", { name: "Изменить предложенный сценарий", exact: true }).click();
    await expect(child.getByLabel("Цель", { exact: true })).toHaveValue("Собственный ввод B после миграции");
    expect(await page.evaluate((key) => sessionStorage.getItem(key), childKey)).toBe(childValue);
  });
}
