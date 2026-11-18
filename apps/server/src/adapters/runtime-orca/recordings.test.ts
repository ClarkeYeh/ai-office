import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { checkReceipt, parseResult } from './schemas/index.js';
import { DispatchLedger } from './ledger.js';

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
