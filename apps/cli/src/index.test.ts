import { expect, test } from 'vitest';
import { runCli } from './index.js';

test('start refuses fake mode without --dev', async () => {
  expect(await runCli(['start', '--fake', 'mainline'])).toMatchObject({
    exitCode: 1,
    message: expect.stringContaining('requires --dev'),
  });
});
test.each([undefined, '--help', '-h', 'unknown'])(
  'shows usage for %s',
  async (arg) => {
    const result = await runCli(arg ? [arg] : []);
    expect(result.message).toBe(
      'Usage: ai-office <submit|start|open> | --version',
    );
    expect(result.exitCode).toBe(arg === 'unknown' ? 1 : 0);
  },
);
