import { defineConfig } from 'vitest/config';

// Vitest 4 calls workspace configurations "projects".
export default defineConfig({
  root: import.meta.dirname,
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/{domain,engine,projection}/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test-support/**'],
      thresholds: {
        perFile: true,
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
    projects: [
      'packages/*',
      'apps/*',
      {
        test: {
          name: '@ai-office/server-orca',
          include: ['apps/server/src/**/*.orca.test.ts'],
          // Live files share one Orca and a global post-cleanup leak scan,
          // so a concurrent file's resources would false-fail another file.
          fileParallelism: false,
        },
      },
      {
        test: { name: 'fixtures', include: ['scripts/fixtures/**/*.test.ts'] },
      },
    ],
  },
});
