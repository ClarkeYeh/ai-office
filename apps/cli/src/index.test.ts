import { expect, test } from 'vitest';
import { runCli } from './index.js';

test('start remains available for composition-root implementation', async () => {
  expect(await runCli(['start'])).toEqual({
    exitCode: 1,
    message: 'start is not implemented yet.',
  });
});
test.each([undefined, '--help', '-h', 'unknown'])(
  'shows usage for %s',
  async (arg) => {
    const result = await runCli(arg ? [arg] : []);
    expect(result.message).toBe('Usage: ai-office <submit|start>');
    expect(result.exitCode).toBe(arg === 'unknown' ? 1 : 0);
  },
);
