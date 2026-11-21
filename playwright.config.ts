import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (PROMPT.md 4, 9): real browser, real app, real PostgreSQL.
 * Locally they reuse an already running `pnpm dev` on :3000; in CI the dev server is
 * started by Playwright. Desktop viewport 1366 px (PROMPT.md 5.3).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    ...devices['Desktop Chrome'],
    viewport: { width: 1366, height: 800 },
    locale: 'bg-BG',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: {
    command: 'pnpm --filter @kantora/web dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
