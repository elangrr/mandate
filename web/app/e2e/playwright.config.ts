import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "out/test-results",
  timeout: 45_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.MD_APP_URL, trace: "off", screenshot: "only-on-failure" },
});
