import { expect, test } from 'vitest';

// Retire each placeholder from this smoke test as its feature gets dedicated tests.
test('skeleton module entry points can be loaded', async () => {
  const modules = await Promise.all([
    import('./api/index.js'),
    import('./app/index.js'),
    import('./features/gates/index.js'),
    import('./features/index.js'),
    import('./features/office/index.js'),
    import('./features/office/model/index.js'),
    import('./features/office/scene/index.js'),
    import('./features/office/ui/index.js'),
    import('./features/repos/index.js'),
    import('./features/seats/index.js'),
    import('./features/templates/index.js'),
    import('./features/timeline/index.js'),
    import('./features/workflows/index.js'),
    import('./realtime/index.js'),
  ]);
  expect(modules).toHaveLength(14);
});
