import { defineConfig } from 'vitest/config';

// Vitest 4 calls workspace configurations "projects".
export default defineConfig({
  root: import.meta.dirname,
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'packages/{domain,engine,projection}/src/**/*.ts',
        'apps/web/src/{features/*/model,realtime,shared/lib}/**/*.ts',
      ],
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
      ...[
        'contracts',
        'domain',
        'engine',
        'projection',
        'redaction',
        'templates',
      ].map((name) => ({
        test: {
          name: '@ai-office/' + name,
          root: 'packages/' + name,
          include: ['src/**/*.test.ts'],
        },
      })),
      ...['server', 'cli'].map((name) => ({
        test: {
          name: '@ai-office/' + name,
          root: 'apps/' + name,
          include: ['src/**/*.test.ts'],
        },
      })),
      {
        test: {
          name: '@ai-office/web',
          root: 'apps/web',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: '@ai-office/web-dom',
          root: 'apps/web',
          environment: 'happy-dom',
          include: ['src/**/*.test.tsx'],
        },
      },
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
