import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;

// Each spec file starts its own `ai-office start --dev --fake` process
// (test-support/office.ts); there is no shared webServer.
export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled' },
  },
  // dist/ is already ignored by git, Prettier, ESLint and depcruise.
  outputDir: 'dist/test-results',
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  ...(ci ? { workers: 2 } : {}),
  reporter: ci
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: 'dist/playwright-report' }],
      ]
    : [['list']],
  // Linux-only baselines; no platform suffix (§7.3).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'e2e', testIgnore: ['visual.spec.ts'] },
    // "2×" is the scene's own integer scale (?scale=2); DPR 1 keeps the
    // screenshot free of resampling.
    { name: 'visual', testMatch: ['visual.spec.ts'] },
    {
      name: 'fps',
      testDir: 'perf',
      testMatch: ['fps.spec.ts'],
      timeout: 180_000,
    },
  ],
});
