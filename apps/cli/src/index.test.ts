import { expect, test } from 'vitest';
import { runCli } from './index.js';

test.each(['submit', 'start'])('%s reports that it is a stub', (command) => {
  expect(runCli([command])).toEqual({
    exitCode: 1,
    message: command + ' is not implemented yet.',
  });
});
test('shows usage', () => {
  expect(runCli(['--help'])).toEqual({
    exitCode: 0,
    message: 'Usage: ai-office <submit|start>',
  });
});
