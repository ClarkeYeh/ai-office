import { describe, expect, it } from 'vitest';
import { assertCommand } from './command-gate.js';
import { emptyLedger } from './ledger.js';
import { scanResources } from './scan.js';
import { RecordingExec, Normalizer } from './recording.js';

function owned() {
  const ledger = emptyLedger('/spike', '', '/tmp/private');
  ledger.runs.push('run_test');
  ledger.requests.push('request');
  ledger.shims.push({ id: 'shim', done: false });
  ledger.tasks.push({ id: 'task', done: false });
  ledger.dispatches.push({ id: 'dispatch', done: false, stopped: false });
  ledger.worktrees.push({
    id: 'worktree',
    name: 'aio-test-one',
    comment: 'aio:test',
    branch: 'ai-office-test/one',
    done: false,
  });
  return ledger;
}
describe('Orca help-verified flags', () => {
  it.each([
    ['run-use', '--id', 'run_test', '--from', 'shim'],
    ['run-show', '--id', 'run_test'],
    [
      'check',
      '--terminal',
      'shim',
      '--run',
      'run_test',
      '--wait',
      '--timeout-ms',
      '10',
    ],
    ['request-show', '--request', 'request'],
    ['worker-stop', '--dispatch', 'dispatch'],
    ['worker-release', '--dispatch', 'dispatch'],
    [
      'task-update',
      '--id',
      'task',
      '--run',
      'run_test',
      '--from',
      'shim',
      '--status',
      'failed',
      '--result',
      'cancelled',
    ],
  ])('accepts %s', (...args) => {
    expect(() =>
      assertCommand(
        ['orchestration', ...args, '--json', '--full'],
        owned(),
        false,
      ),
    ).not.toThrow();
  });
  it.each([
    ['orchestration', 'run-use', '--run', 'run_test', '--from', 'shim'],
    ['orchestration', 'run-show', '--id', 'foreign'],
    ['orchestration', 'check', '--from', 'shim', '--run', 'run_test'],
    ['orchestration', 'check', '--terminal', 'foreign', '--run', 'run_test'],
    ['orchestration', 'request-show', '--request-id', 'request'],
    ['orchestration', 'request-show', '--request', 'request', '--from', 'shim'],
    [
      'orchestration',
      'worker-stop',
      '--dispatch',
      'dispatch',
      '--from',
      'shim',
    ],
    [
      'orchestration',
      'worker-release',
      '--dispatch',
      'dispatch',
      '--from',
      'shim',
    ],
    ['worktree', 'rm', '--worktree', 'id:worktree', '--full'],
    ['terminal', 'close', '--terminal', 'shim', '--full'],
  ])('rejects invalid shape %s %s', (...args) => {
    expect(() => assertCommand(args, owned(), false)).toThrow();
  });
});

it('scans independent worktrees, home shims, and local/remote branches without authorizing deletion', async () => {
  const calls: readonly string[][] = [];
  const result = await scanResources(
    '/spike',
    '/home/test/.ai-office/orca-home',
    async (kind, args) => {
      (calls as string[][]).push([...args]);
      if (kind === 'orca')
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result:
              args[0] === 'worktree'
                ? {
                    worktrees: [
                      { id: 'lost', displayName: 'aio-test-lost' },
                      { id: 'other', displayName: 'user-work' },
                    ],
                  }
                : {
                    terminals: [
                      { handle: 'shim', title: 'aio-test-shim' },
                      { handle: 'other', title: 'user-shell' },
                    ],
                  },
          }),
        };
      return {
        exitCode: 0,
        stdout: args.includes('for-each-ref')
          ? 'ai-office-test/local\naio-test-legacy\nmain\n'
          : 'abc123\trefs/heads/ai-office-test/remote\nabc124\trefs/heads/aio-test-legacy\n',
      };
    },
  );
  expect(result.map((r) => r.kind)).toEqual([
    'worktree',
    'shim',
    'localBranch',
    'localBranch',
    'remoteBranch',
    'remoteBranch',
  ]);
  expect(calls[0]).toContain('path:/spike');
  expect(calls[1]).toContain('path:/home/test/.ai-office/orca-home');
  expect(
    calls.flat().some((arg) => ['rm', 'close', 'push', '-D'].includes(arg)),
  ).toBe(false);
});

it('refuses to claim zero leftovers when inventory is incomplete', async () => {
  await expect(
    scanResources('/spike', '/shim', async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        result: { worktrees: [], hasMore: true },
      }),
    })),
  ).rejects.toThrow('Incomplete');
});

it('filters unrelated repos before recording and masks gitUsername', async () => {
  const response = {
    ok: true,
    result: {
      repos: [
        { path: '/Users/test/spike', gitUsername: 'private-owner' },
        {
          path: '/Users/test/.ai-office/orca-home',
          gitUsername: 'private-owner',
        },
        {
          path: '/Users/test/unrelated-secret-project',
          gitUsername: 'private-owner',
        },
      ],
      unrelated: '/Users/test/also-private',
    },
  };
  const exec = new RecordingExec(
    { run: async () => ({ stdout: JSON.stringify(response), exitCode: 0 }) },
    '1.4.259',
  );
  const original = await exec.run({
    bin: '/orca',
    args: ['repo', 'list', '--json'],
    cwd: '/tmp',
    env: { HOME: '/Users/test', AIO_TEST_REPO_PATH: '/Users/test/spike' },
    timeoutMs: 10,
  });
  expect(JSON.parse(original.stdout)).toEqual(response);
  const saved = JSON.stringify(exec.recordings);
  expect(saved).not.toMatch(/unrelated|also-private|private-owner|\/Users\//);
  expect(
    (exec.recordings[0]?.response as typeof response).result.repos,
  ).toHaveLength(2);
  expect(new Normalizer().value({ gitUsername: 'someone' })).toEqual({
    gitUsername: '<redacted>',
  });
});
