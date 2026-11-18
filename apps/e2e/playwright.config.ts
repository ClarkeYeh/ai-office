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
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  ...(ci ? { workers: 2 } : {}),
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Linux-only baselines; no platform suffix (§7.3).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'e2e', testIgnore: ['visual.spec.ts'] },
    {
      name: 'visual',
      testMatch: ['visual.spec.ts'],
      use: { deviceScaleFactor: 2 },
    },
    {
      name: 'fps',
      testDir: 'perf',
      testMatch: ['fps.spec.ts'],
      timeout: 180_000,
    },
  ],
});
