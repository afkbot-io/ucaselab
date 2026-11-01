import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { authDir, actors } from "./setup";
import type {
  Project,
  UseCase,
  CaseContent,
  Specification,
  Environment,
  Plan,
  Run,
} from "../src/types";

type ActorRole = (typeof actors)[number];
class API {
  constructor(
    readonly request: APIRequestContext,
    private csrf: string,
  ) {}
  static async connect(request: APIRequestContext) {
    const response = await request.get("/api/auth/me");
    expect(response.ok()).toBeTruthy();
    return new API(request, (await response.json()).csrf);
  }
  async call<T>(
    name: string,
    projectId: string | null = null,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await this.raw(name, projectId, args);
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
    return response.json() as Promise<T>;
  }
  raw(
    name: string,
    projectId: string | null = null,
    args: Record<string, unknown> = {},
  ) {
    return this.request.post("/api/actions/" + name, {
      headers: { "X-CSRF-Token": this.csrf },
      data: { project_id: projectId, arguments: args },
    });
  }
  async profile(data: Record<string, unknown>) {
    const result = await this.request.patch("/api/auth/profile", {
      headers: { "X-CSRF-Token": this.csrf },
      data,
    });
    expect(result.ok()).toBeTruthy();
  }
  acceptInvitation(token: string) {
    return this.request.post("/api/auth/accept-invitation", {
      headers: { "X-CSRF-Token": this.csrf },
      data: { token },
    });
  }
}

const caseContent = (title = "Вход в личный кабинет"): CaseContent => ({
  title,
  goal: "Пользователь входит в свой аккаунт и получает доступ к профилю.",
  preconditions:
    "Откройте тестовое приложение в новой сессии браузера.\n\nПодготовьте выделенный тестовый аккаунт. Производственные данные не используются.",
  cleanup: "Завершите тестовую сессию.",
  priority: "high",
  tags: ["Авторизация", "Регрессия"],
  platforms: ["Web"],
  steps: [
    {
      key: "open",
      action: "Откройте страницу /login.",
      expected: "Появилась форма входа.",
    },
    {
      key: "submit",
      action: "Введите данные выбранного варианта и нажмите «Войти».",
      expected: "Результат соответствует варианту данных.",
    },
  ],
  variants: [
    {
      key: "valid",
      name: "Правильные данные",
      polarity: "positive",
      inputs: { login: "qa@example.invalid" },
      expected: "Открыт профиль пользователя.",
      notes: "Пароль берётся из тестового аккаунта.",
      enabled: true,
    },
    {
      key: "invalid",
      name: "Неверный пароль",
      polarity: "negative",
      inputs: { password: "synthetic-invalid" },
      expected: "Показано общее сообщение об ошибке входа.",
      notes: "",
      enabled: true,
    },
  ],
  specifications: [],
  accounts: [],
});
type Workspace = {
  project: Project;
  case: UseCase;
  draft: UseCase;
  spec: Specification;
  env: Environment;
  plan: Plan;
  run: Run;
  identities: Record<
    ActorRole,
    { id: string; email: string; password: string }
  >;
  apis: Record<ActorRole, API>;
  asRole: (
    role: ActorRole,
  ) => Promise<{ context: BrowserContext; page: Page; api: API }>;
};
export const test = base.extend<{ api: API; workspace: Workspace }>({
  storageState: async ({}, use) => use(path.join(authDir, "owner.json")),
  api: async ({ request }, use) => use(await API.connect(request)),
  workspace: async ({ api, playwright, baseURL, browser }, use, info) => {
    const identities = JSON.parse(
      await fs.readFile(path.join(authDir, "identities.json"), "utf8"),
    ) as Workspace["identities"];
    await api.profile({ theme: "system" });
    const project = await api.call<Project>("create_project", null, {
      name: "Тест интерфейса · " + randomUUID().slice(0, 8),
      key: "E" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
      description: "Изолированный проект автоматической проверки интерфейса.",
    });
    const pid = project.id;
    const apis = { owner: api } as Record<ActorRole, API>;
    const requests: APIRequestContext[] = [];
    const contexts: BrowserContext[] = [];
    for (const role of [
      "manager",
      "tester",
      "developer",
      "outsider",
    ] as const) {
      const request = await playwright.request.newContext({
        baseURL,
        storageState: path.join(authDir, role + ".json"),
      });
      requests.push(request);
      apis[role] = await API.connect(request);
      if (role !== "outsider") {
        const invitation = await api.call<{ invitation_url: string }>(
          "invite_project_member",
          pid,
          { email: identities[role].email, role, send_email: false },
        );
        const response = await apis[role].acceptInvitation(
          new URL(invitation.invitation_url).searchParams.get("token")!,
        );
        expect(response.ok()).toBeTruthy();
      }
    }
    const env = await api.call<Environment>("create_environment", pid, {
      name: "Dev",
      base_url: "https://example.invalid",
      description: "Синтетический стенд UI-теста.",
    });
    const spec = await api.call<Specification>("create_specification", pid, {
      title: "Вход и сообщения об ошибках",
      description:
        "Допустимые данные открывают профиль. Ошибка входа не раскрывает существование аккаунта.",
      tags: ["Безопасность"],
      acceptance_criteria: "Форма доступна с клавиатуры.",
    });
    const content = caseContent();
    content.specifications = [{ specification_id: spec.id }];
    let c = await api.call<UseCase>("create_use_case", pid, { content });
    c = await api.call<UseCase>("publish_use_case", pid, {
      use_case_id: c.id,
      expected_version: c.version,
      revision_id: c.revision_id,
      message: "Фикстура опубликованного сценария",
    });
    const draft = await api.call<UseCase>("create_use_case", pid, {
      content: caseContent("Восстановление доступа · черновик"),
    });
    const plan = await api.call<Plan>("create_case_plan", pid, {
      content: { title: "Регрессия аккаунта", items: [{ use_case_id: c.id }] },
      status: "active",
    });
    const run = await api.call<Run>("create_run", pid, {
      title: "Проверка входа",
      use_case_ids: [c.id],
      environment_id: env.id,
    });
    const asRole: Workspace["asRole"] = async (role) => {
      const { viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } =
        info.project.use;
      const context = await browser.newContext({
        viewport,
        isMobile,
        hasTouch,
        userAgent,
        deviceScaleFactor,
        baseURL,
        storageState: path.join(authDir, role + ".json"),
      });
      contexts.push(context);
      return { context, page: await context.newPage(), api: apis[role] };
    };
    try {
      await use({
        project,
        case: c,
        draft,
        spec,
        env,
        plan,
        run,
        identities,
        apis,
        asRole,
      });
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
      await Promise.all(requests.map((r) => r.dispose()));
    }
  },
});
export { expect };

/** Open the project navigation on a narrow viewport without relying on screen coordinates. */
export async function navigateSection(page: Page, name: string) {
  await expect(page.getByRole("main")).toBeVisible();
  const menu = page.getByRole("button", { name: "Меню", exact: true });
  if (
    !(await page
      .getByRole("navigation", { name: "Основная навигация" })
      .isVisible())
  )
    await menu.click();
  await page
    .getByRole("navigation", { name: "Основная навигация" })
    .getByRole("link", { name: new RegExp("^" + name) })
    .click();
}
export async function expectNoOverflow(page: Page) {
  const widths = await page.evaluate(() =>
    [
      document.documentElement,
      ...document.querySelectorAll<HTMLElement>(".workspace,.dialog[open]"),
    ]
      .filter((e) => e.clientWidth > 0)
      .map((e) => ({
        element: e.className || e.tagName,
        width: e.clientWidth,
        content: e.scrollWidth,
      })),
  );
  for (const value of widths)
    expect(value.content, JSON.stringify(value)).toBeLessThanOrEqual(
      value.width + 1,
    );
}
