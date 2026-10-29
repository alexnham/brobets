import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  use: { baseURL: "http://localhost:3017", trace: "retain-on-failure" },
  webServer: {
    command: process.env.BROBETS_TEST_PRODUCTION
      ? "npm run start -- --port 3017"
      : "npm run dev -- --port 3017",
    url: "http://localhost:3017",
    reuseExistingServer: !process.env.CI,
    env: { APP_ORIGIN: "http://localhost:3017", HELIUS_API_KEY: "" },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
