import { collectDispatchUsage } from './usage.js';
import { detectRateLimitPause } from './rate-limit.js';
import { UsageCursorSchema } from '../../ports/refs.js';
import { readFile, readdir, mkdtemp, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { summarize } from '@ai-office/redaction';
import {
  Normalizer,
  RecordingExec,
  ReplayExec,
  type Recording,
} from './recording.js';
import { assertCommand } from './command-gate.js';
import {
  cleanup,
  emptyLedger,
  leftovers,
  loadLedger,
  saveLedger,
  type CleanupDriver,
} from './ledger.js';
import { assertOutside, assertTestRepo, TEST_REPO_URL } from './safety.js';
import {
  P2_CONFIRMATION,
  prepareP2,
  requireInteractiveConfirmation,
  resumeP2,
  type P2State,
} from './p2.js';
import type { ExecRequest } from '../../adapters/runtime-orca/cli/types.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'aio-test-unit-'));
  temporary.push(path);
  return path;
}
const request = (args: readonly string[]): ExecRequest => ({
  bin: 'orca',
  args,
  cwd: '/tmp',
  env: {},
  timeoutMs: 1000,
});
function ledger() {
  const l = emptyLedger('/spike', TEST_REPO_URL, '/tmp/aio-test-unit');
  l.runs.push('run_owned');
  l.shims.push({ id: 'term_owned', done: false });
  l.dispatches.push({ id: 'ctx_owned', stopped: false, done: false });
  return l;
}

describe('recording and replay', () => {
  it('replays every day-1 JSON recording without executing a subprocess', async () => {
    const root = resolve(
      import.meta.dirname,
      '../../../../../fixtures/orca/1.4.259',
    );
    const files = (await readdir(root)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(50);
    for (const file of files) {
      const recording = JSON.parse(
        await readFile(join(root, file), 'utf8'),
      ) as Recording;
      const replay = new ReplayExec({ default: [recording] });
      const result = await replay.run(request(recording.argv.slice(1)));
      expect(result.exitCode).toBe(recording.exitCode);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      replay.assertConsumed();
    }
  });
  it('normalizes identities consistently and hashes private body text before transforming it', () => {
    const n = new Normalizer();
    const id = '12345678-1234-4234-8234-123456789abc';
    const value = n.value({
      handle: `term_${id}`,
      paneKey: `${id}:${id}`,
      path: '/Users/example/work',
      body: '/Users/example/private body',
    }) as Record<string, string>;
    expect(value.handle).toBe('term_00000000-0000-4000-8000-000000000001');
    expect(value.paneKey).toBe(
      '00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000001',
    );
    expect(value.path).toBe('<home>/work');
    expect(value.body).toBe(summarize('/Users/example/private body'));
  });
  it('records parsed receipts for exit 1, omits environment and private inputs, and supports segments', async () => {
    const recorder = new RecordingExec(
      {
        run: async () => ({
          stdout: JSON.stringify({
            ok: true,
            body: 'private message',
            token: 'private credential',
          }),
          exitCode: 1,
        }),
      },
      '1.4.259',
    );
    await recorder.run(
      request(['orchestration', 'send', '--body', 'private input']),
    );
    expect(JSON.stringify(recorder.recordings)).not.toMatch(
      /private|stdout|stderr"/,
    );
    const replay = new ReplayExec({ default: recorder.recordings, next: [] });
    await expect(replay.run(request(['wrong']))).rejects.toThrow('mismatch');
    const result = await replay.run(
      request(['orchestration', 'send', '--body', 'different input']),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('recorded body');
    replay.stimulus('next');
    replay.assertConsumed();
  });
  it('binds arbitrary request UUIDs to existing fixture placeholders', async () => {
    const r: Recording = {
      orcaVersion: '1',
      recordedAt: '',
      argv: [
        'orca',
        'status',
        '--retry-request',
        '00000000-0000-4000-8000-000000000030',
      ],
      exitCode: 0,
      response: {},
      stderrLines: [],
    };
    await new ReplayExec({ default: [r] }).run(
      request([
        'status',
        '--retry-request',
        '12345678-1234-4234-8234-123456789abc',
      ]),
    );
  });
});

describe('safety and cleanup', () => {
  it('refuses other origins, unowned dispatches, unfiltered inbox, unknown flags and resets', async () => {
    await expect(
      assertTestRepo(
        { originUrl: async () => 'https://github.com/ClarkeYeh/ai-office' },
        '/spike',
      ),
    ).rejects.toThrow();
    await assertTestRepo(
      { originUrl: async () => 'git@github.com:ClarkeYeh/ai-office-spike.git' },
      '/spike',
    );
    for (const args of [
      [
        'orchestration',
        'worker-stop',
        '--dispatch',
        'ctx_other',
        '--from',
        'term_owned',
      ],
      ['orchestration', 'inbox'],
      ['orchestration', 'reset'],
      ['terminal', 'close', '--all'],
      [
        'orchestration',
        'run-use',
        '--run',
        'run_other',
        '--from',
        'term_owned',
      ],
      [
        'orchestration',
        'worker-show',
        '--dispatch',
        'ctx_owned',
        '--on',
        'other-host',
      ],
    ])
      expect(() => assertCommand(args, ledger(), false)).toThrow();
    expect(() =>
      assertCommand(
        ['orchestration', 'inbox', '--terminal', 'run:run_owned'],
        ledger(),
        false,
      ),
    ).not.toThrow();
    const root = await directory();
    await expect(assertOutside(root, [root])).rejects.toThrow();
  });
  it('requires a live TTY and typed P2 confirmation', () => {
    for (const input of [
      { stdinTTY: false, stdoutTTY: true, answer: P2_CONFIRMATION },
      { stdinTTY: true, stdoutTTY: false, answer: P2_CONFIRMATION },
      { stdinTTY: true, stdoutTTY: true, answer: '' },
    ])
      expect(() => requireInteractiveConfirmation(input)).toThrow();
    expect(() =>
      requireInteractiveConfirmation({
        stdinTTY: true,
        stdoutTTY: true,
        answer: P2_CONFIRMATION,
      }),
    ).not.toThrow();
  });
  it('persists progress, retries failed release, and only deletes recorded test branches', async () => {
    const root = await directory();
    const path = join(root, 'ledger.json');
    const l = ledger();
    l.localBranches.push({ id: 'ai-office-test/example', done: false });
    const calls: string[] = [];
    let failRelease = true;
    const driver: CleanupDriver = {
      stop: async () => {
        calls.push('stop');
      },
      release: async () => {
        calls.push('release');
        if (failRelease) throw new Error('retry');
      },
      removeWorktree: async () => {
        calls.push('worktree');
      },
      closeShim: async () => {
        calls.push('shim');
      },
      deleteLocal: async () => {
        calls.push('local');
      },
      deleteRemote: async () => {
        calls.push('remote');
      },
      failTask: async () => {
        calls.push('task');
      },
    };
    await expect(
      cleanup(l, driver, () => saveLedger(path, l)),
    ).rejects.toThrow();
    const restored = await loadLedger(path);
    expect(restored.dispatches[0]?.stopped).toBe(true);
    failRelease = false;
    await cleanup(restored, driver, () => saveLedger(path, restored));
    expect(calls).toEqual(['stop', 'release', 'release', 'shim', 'local']);
    expect(leftovers(restored)).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('writes resumable P2 state privately, with run ownership validated', async () => {
    const root = await directory();
    const l = ledger();
    l.dataDir = root;
    const state: P2State = {
      format: 1,
      phase: 'prepared',
      preparedAt: 'now',
      version: '1.4.259',
      run: 'run_owned',
      shim: 'term_owned',
      consumerGeneration: 1,
      cursor: null,
      lastSeq: 3,
      requestIds: ['request'],
      checkRequestId: null,
      dispatchStates: { ctx_owned: 'succeeded' },
      ledger: l,
      backend: null,
    };
    const path = join(root, 'p2.json');
    await prepareP2(path, state, [process.cwd()], {
      stdinTTY: true,
      stdoutTTY: true,
      answer: P2_CONFIRMATION,
    });
    expect(await resumeP2(path)).toEqual(state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

it('collects cumulative numeric usage once and delegates in-memory rate-limit detection', async () => {
  const totals: unknown[] = [];
  await collectDispatchUsage(
    {
      collectUsage: async (read) => {
        totals.push(...(await read()));
      },
    },
    [{ attemptId: 'attempt', agent: 'codex', dispatchId: 'dispatch' }],
    {
      capabilities: () => ({
        source: 'session-log',
        agents: ['codex'],
        formatVerified: true,
      }),
      locate: async () => ({
        attemptId: 'attempt',
        agent: 'codex',
        sessionId: 'session',
        file: '/unused',
      }),
      read: async () => ({
        cursor: UsageCursorSchema.parse('cursor'),
        samples: [
          {
            externalKey: 'sample1',
            occurredAt: 'now',
            inputUncached: 100,
            cacheRead: 20,
            cacheWrite: 0,
            output: 30,
            cumulative: true,
          },
          {
            externalKey: 'sample2',
            occurredAt: 'now',
            inputUncached: 200,
            cacheRead: 20,
            cacheWrite: 0,
            output: 60,
            cumulative: true,
          },
        ],
      }),
    },
  );
  expect(totals).toEqual([{ provider: 'codex', input: 220, output: 60 }]);
  expect(
    detectRateLimitPause(
      { observation: { agentWait: 'waiting' } },
      'private',
      (e) => e.agentWait === 'waiting',
    ),
  ).toBe(true);
});

it('accepts normalized receipt identities in later replay calls', async () => {
  const id = '00000000-0000-4000-8000-000000000030';
  const row: Recording = {
    orcaVersion: '1',
    recordedAt: '',
    argv: ['orca', 'status', '--retry-request', id],
    exitCode: 0,
    response: { id },
    stderrLines: [],
  };
  const replay = new ReplayExec({ default: [row, row] });
  await replay.run(
    request([
      'status',
      '--retry-request',
      '12345678-1234-4234-8234-123456789abc',
    ]),
  );
  await replay.run(request(['status', '--retry-request', id]));
  replay.assertConsumed();
});

it('runs the complete CLI-only lifecycle against fake exec and leaves zero ledger resources', async () => {
  const { OrcaHarness } = await import('./harness.js');
  const repo = await directory();
  const calls: string[][] = [];
  const harness = await OrcaHarness.create({
    repoPath: repo,
    sourceRoot: process.cwd(),
    orcaBin: '/fake/orca',
    worktreePaths: async () => [],
    env: { AIO_REAL_ORCA: '1', HOME: repo },
    exec: {
      run: async (req) => {
        calls.push([...req.args]);
        if (req.bin === 'git') {
          if (req.args.includes('get-url'))
            return { stdout: TEST_REPO_URL, exitCode: 0 };
          if (req.args.includes('show-ref')) return { stdout: '', exitCode: 1 };
          if (req.args.includes('ls-remote'))
            return { stdout: '', exitCode: 2 };
          return { stdout: '', exitCode: 0 };
        }
        let result: unknown = {};
        if (req.args[0] === 'terminal' && req.args[1] === 'create')
          result = { terminal: { handle: 'term_owned' } };
        if (req.args[1] === 'run-create') result = { run: { id: 'run_owned' } };
        if (req.args[0] === 'worktree' && req.args[1] === 'create')
          result = {
            worktree: {
              id: 'wt_owned',
              branch: 'ai-office-test/unit',
              displayName: 'aio-test-unit',
              comment: 'aio:aio-test-unit',
            },
          };
        return { stdout: JSON.stringify({ ok: true, result }), exitCode: 0 };
      },
    },
  });
  temporary.push(harness.ledger.dataDir);
  await harness.createShim(join(repo, '.ai-office', 'orca-home'));
  await harness.createRun('term_owned', 'unit');
  await harness.createWorktree(
    'aio-test-unit',
    'ai-office-test/unit',
    'a'.repeat(40),
  );
  await harness.clean();
  expect(leftovers(harness.ledger)).toEqual([]);
  expect(
    calls.some(
      (args) => args.includes('-D') && args.includes('ai-office-test/unit'),
    ),
  ).toBe(true);
});
