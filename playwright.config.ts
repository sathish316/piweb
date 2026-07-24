import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4783",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile-chromium", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run build && PI_WEB_ADAPTER=fake PI_WORKBENCH_SETTINGS_PATH=test-results/e2e-settings.json npm start",
    url: "http://127.0.0.1:4783/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
