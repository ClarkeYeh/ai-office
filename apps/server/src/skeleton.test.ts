import { expect, test } from 'vitest';

// Retire each placeholder from this smoke test as its feature gets dedicated tests.
test('skeleton module entry points can be loaded', async () => {
  const modules = await Promise.all([
    import('./adapters/index.js'),
    import('./adapters/logger-pino/index.js'),
    import('./adapters/redactor/index.js'),
    import('./adapters/runtime-fake/index.js'),
    import('./adapters/runtime-orca/coordinator-identity/index.js'),
    import('./adapters/runtime-orca/env-allowlist.js'),
    import('./adapters/runtime-orca/index.js'),
    import('./adapters/runtime-orca/observe/index.js'),
    import('./adapters/scm-fake/index.js'),
    import('./adapters/scm-github/index.js'),
    import('./adapters/store-sqlite/index.js'),
    import('./adapters/store-sqlite/migrations/index.js'),
    import('./adapters/store-sqlite/upcasters/index.js'),
    import('./adapters/template-fs/index.js'),
    import('./adapters/usage-fake/index.js'),
    import('./adapters/usage-sessionlog/index.js'),
    import('./agent-gateway/index.js'),
    import('./api/index.js'),
    import('./application/index.js'),
    import('./config/index.js'),
    import('./ports/index.js'),
  ]);
  expect(modules).toHaveLength(21);
});
