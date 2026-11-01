import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const artifacts = path.resolve("../../output/playwright/e2e");
const webPort = Number(process.env.UCASELAB_E2E_WEB_PORT || 4173);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535)
  throw new Error(
    "UCASELAB_E2E_WEB_PORT must be an integer between 1024 and 65535",
  );
const webURL = `http://localhost:${webPort}`;
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/setup.ts",
  outputDir: path.join(artifacts, "results"),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(artifacts, "report"), open: "never" }],
    ["json", { outputFile: path.join(artifacts, "results.json") }],
  ],
  use: {
    baseURL: webURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    colorScheme: "light",
  },
  webServer: [
    {
      command: `uv run --frozen python scripts/run_e2e_api.py --origin ${webURL}`,
      cwd: "../..",
      url: "http://127.0.0.1:18017/api/health/ready",
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
      timeout: 90_000,
    },
    {
      command: `npm run build && npm exec -- vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
      env: { UCASELAB_API_URL: "http://127.0.0.1:18017" },
      url: `${webURL}/auth/login`,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "firefox",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
