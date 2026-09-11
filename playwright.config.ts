import { defineConfig } from '@playwright/test';
process.env.POC_MODE = 'true';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180000,
  expect: { timeout: 30000 },
  workers: 1,
  retries: 0,
  outputDir: 'output/playwright/test-results',
  reporter: [['line'], ['html', { outputFolder: 'output/playwright/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    locale: 'ko-KR',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { chromiumSandbox: true },
  },
  webServer: [
    {
      command: 'pnpm dev:demo',
      url: 'http://127.0.0.1:4001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'pnpm dev:api',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'pnpm dev:worker',
      url: 'http://127.0.0.1:4002/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'pnpm preview:web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
});
