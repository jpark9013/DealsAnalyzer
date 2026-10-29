import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Traces record every action's arguments; keep them off so no key can end up in one.
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    // Hermetic: fixture pages and a stubbed API. Runs in CI.
    { name: 'e2e', testIgnore: /live\.spec\.js/ },
    // Real eDealinfo page and the real Claude API. Local only: `npm run test:live`.
    { name: 'live', testMatch: /live\.spec\.js/, timeout: 240_000 }
  ]
});
