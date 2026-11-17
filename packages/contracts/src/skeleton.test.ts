import { expect, test } from 'vitest';

// Retire each placeholder from this smoke test as its feature gets dedicated tests.
test('skeleton module entry points can be loaded', async () => {
  const modules = await Promise.all([
    import('./agent-submission/index.js'),
    import('./api/index.js'),
    import('./events/index.js'),
    import('./stream/index.js'),
    import('./template/index.js'),
  ]);
  expect(modules).toHaveLength(5);
});
