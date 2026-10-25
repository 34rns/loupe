import { defineConfig } from '@playwright/test';

// Single worker: each run owns one persistent browser context with the extension loaded.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 6_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']]
});