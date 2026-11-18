import { expect, it } from 'vitest';
import { createFakeUsage } from './index.js';

it('preserves session identity, cumulative samples, source and cursor offsets', async () => {
  const original = createFakeUsage();
  const query = {
    attemptId: 'attempt',
    agent: 'codex' as const,
    dispatchId: 'dispatch',
  };
  const ref = original.registerAttempt(query);
  original.append('attempt', {
    inputUncached: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const first = await original.read(ref, null);
  original.append('attempt', {
    inputUncached: 20,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
  });
  original.setSource('none');
  const restored = createFakeUsage();
  restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
  expect(restored.capabilities().source).toBe('none');
  restored.setSource('session-log');
  expect(await restored.locate(query)).toEqual(ref);
  expect((await restored.read(ref, first.cursor)).samples).toMatchObject([
    { inputUncached: 20, output: 4, cumulative: true },
  ]);
});
