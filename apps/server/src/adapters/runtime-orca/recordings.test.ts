import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { checkReceipt, parseResult } from './schemas/index.js';
import { DispatchLedger, LedgerTasksSchema } from './ledger.js';
import { TaskListSchema } from './observe/schemas.js';
import { DefaultOrcaCli } from './cli/index.js';
import { CwdGuard } from './cli/cwd.js';
import type { ExecRequest } from './cli/types.js';

function recording(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../../../fixtures/orca/1.4.259/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { response: unknown; argv: string[]; exitCode: number };
}
it('classifies the recorded ok:true, exit:1 agent_readiness failure', () => {
  const failed = recording('worker-start.agent-readiness-timeout.exit1');
  expect(failed.exitCode).toBe(1);
  const result = parseResult(JSON.stringify(failed.response));
  expect(() => checkReceipt(failed.argv.slice(1), result)).toThrow(
    expect.objectContaining({ category: 'permanent', code: 'failed' }),
  );
});
it('accepts recorded success and follow-up receipts', () => {
  for (const name of [
    'worker-start.claude.ok',
    'worker-start.codex.keep-open.ok',
    'send.follow-up.codex.ok',
    'worker-release.ok',
  ]) {
    const data = recording(name);
    expect(() =>
      checkReceipt(
        data.argv.slice(1),
        parseResult(JSON.stringify(data.response)),
      ),
    ).not.toThrow();
  }
});
it('recovers recorded resource origin links from an empty cache using task titles', () => {
  const data = recording('worker-list.follow-up-retained.ok');
  const result = parseResult(JSON.stringify(data.response));
  // Day-1 did not record task-list; deterministic title metadata joins recorded task IDs.
  const workers = result.workers as {
    dispatchId: string;
    taskId: string;
    runId: string;
    resource: { originDispatchId: string } | null;
  }[];
  const tasks = workers.map((worker, i) => ({
    id: worker.taskId,
    title: `aio:command-${i} example`,
    runId: worker.runId,
  }));
  const ledger = new DispatchLedger({ read: () => null, write: () => {} });
  const run = workers[0]!.runId;
  ledger.rebuild(run, result, { tasks });
  expect(ledger.all()).toHaveLength(workers.length);
  const followup = workers.find(
    (w) => w.resource && w.resource.originDispatchId !== w.dispatchId,
  )!;
  expect(ledger.agentFor(followup.dispatchId)).toBe(
    followup.resource!.originDispatchId,
  );
});
it('rebuilds the ledger from the recorded concise task-list, never the --full view (M2-T17 D3)', () => {
  const concise = parseResult(
    JSON.stringify(recording('task-list.ok').response),
  );
  const full = parseResult(
    JSON.stringify(recording('task-list.full.ok').response),
  );
  const run = String(concise.runId);
  const task = (concise.tasks as { id: string }[])[0]!;
  const workers = {
    workers: [{ dispatchId: 'ctx_recorded', taskId: task.id, runId: run }],
  };
  const ledger = new DispatchLedger({ read: () => null, write: () => {} });
  ledger.rebuild(run, workers, concise);
  expect(ledger.all().map((e) => e.dispatch)).toEqual(['ctx_recorded']);
  // Real --full rows carry task_title/run_id and no `title`: rejected.
  expect(Object.keys((full.tasks as object[])[0]!)).toContain('task_title');
  expect(() => ledger.rebuild(run, workers, full)).toThrow(
    expect.objectContaining({ code: 'runtime_contract_mismatch' }),
  );
});
it('sends worker-stop/worker-release exactly as the recorded argv, never --from/--run (M2-T17 D6)', async () => {
  const requests: ExecRequest[] = [];
  const cli = new DefaultOrcaCli({
    bin: '/bin/orca',
    env: {},
    cwdGuard: new CwdGuard(tmpdir(), async () => []),
    exec: {
      run: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: '{"ok":true,"result":{"state":"stopped"}}',
        };
      },
    },
    identity: {
      argsFor: async (kind) =>
        kind === 'mutate' ? ['--from', 'term_shim'] : [],
    },
  });
  for (const verb of ['worker-stop', 'worker-release']) {
    const recorded = recording(
      verb === 'worker-stop'
        ? 'worker-stop.already-settled.ok'
        : 'worker-release.ok',
    ).argv.slice(1);
    const dispatch = recorded[recorded.indexOf('--dispatch') + 1]!;
    await cli.run(['orchestration', verb, '--dispatch', dispatch], {
      kind: 'mutate',
      priority: 'mutate',
      run: 'run_owned',
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    const argv = requests.at(-1)!.args;
    expect(argv).not.toContain('--from');
    expect(argv).not.toContain('--run');
    // Recorded flags plus the idempotent request id, nothing else.
    expect(argv.filter((a) => a.startsWith('--')).sort()).toEqual(
      [...recorded.filter((a) => a.startsWith('--')), '--retry-request'].sort(),
    );
  }
  // Other mutations keep caller identity and the run.
  await cli.run(['orchestration', 'send', '--to', 'dispatch:ctx'], {
    kind: 'mutate',
    priority: 'mutate',
    run: 'run_owned',
    requestId: '00000000-0000-4000-8000-000000000002',
  });
  expect(requests.at(-1)!.args).toEqual(
    expect.arrayContaining(['--from', 'term_shim', '--run', 'run_owned']),
  );
});
it('refuses a capped task-list instead of rebuilding a partial ledger (M2-FX13)', async () => {
  // Recorded views: no cursor; --full's count equals its rows.
  for (const name of ['task-list.ok', 'task-list.full.ok']) {
    const result = parseResult(JSON.stringify(recording(name).response));
    expect(LedgerTasksSchema.safeParse(result).success).toBe(
      name === 'task-list.ok',
    );
    expect(TaskListSchema.safeParse(result).success).toBe(
      name === 'task-list.ok',
    );
  }
  const full = parseResult(
    JSON.stringify(recording('task-list.full.ok').response),
  );
  expect(full.count).toBe((full.tasks as unknown[]).length);
  // A fake capped response: 100 of 250 rows, or a continuation signal.
  const page = Array.from({ length: 100 }, (_, i) => ({
    id: `task_${i}`,
    title: `aio:command-${i} example`,
  }));
  for (const signal of [
    { count: 250 },
    { nextCursor: 'c2' },
    { hasMore: true },
    { truncated: true },
  ]) {
    const capped = { runId: 'run_owned', tasks: page, ...signal };
    expect(LedgerTasksSchema.safeParse(capped).success).toBe(false);
    expect(TaskListSchema.safeParse(capped).success).toBe(false);
    const ledger = new DispatchLedger({ read: () => null, write: () => {} });
    expect(() => ledger.rebuild('run_owned', { workers: [] }, capped)).toThrow(
      expect.objectContaining({ code: 'runtime_contract_mismatch' }),
    );
    // Startup restore reads through the CLI with LedgerTasksSchema.
    const cli = new DefaultOrcaCli({
      bin: '/bin/orca',
      env: {},
      cwdGuard: new CwdGuard(tmpdir(), async () => []),
      exec: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, result: capped }),
        }),
      },
      identity: { argsFor: async () => [] },
    });
    await expect(
      cli.run(
        ['orchestration', 'task-list'],
        { kind: 'read', priority: 'worker-list', run: 'run_owned' },
        LedgerTasksSchema,
      ),
    ).rejects.toMatchObject({ code: 'runtime_contract_mismatch' });
  }
  // Without a signal, a long run's full list is accepted as complete.
  expect(
    LedgerTasksSchema.safeParse({ tasks: page, count: page.length }).success,
  ).toBe(true);
});
