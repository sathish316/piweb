import { defineConfig, devices } from "@playwright/test";

const e2ePort = parseE2ePort(process.env.E2E_PORT);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: e2eBaseUrl,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile-chromium", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `npm run build && PORT=${e2ePort} PI_WEB_ADAPTER=fake PI_WORKBENCH_SETTINGS_PATH=test-results/e2e-settings-${e2ePort}.json npm start`,
    url: `${e2eBaseUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

function parseE2ePort(value: string | undefined): number {
  if (value === undefined) return 4783;
  if (!/^\d+$/.test(value)) throw new Error("E2E_PORT must be an integer from 1024 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("E2E_PORT must be an integer from 1024 to 65535");
  }
  return port;
}
