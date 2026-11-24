import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Json } from '../../orca/t17/checks.js';
import { PENDING_LINE, reviewedLine } from '../scenario/index.js';
import {
  ancestry,
  conflictFacts,
  firstParents,
  markerCounts,
  reworkFacts,
  type Git,
} from './facts.js';
import { behaviours, killSide, usageLedger } from './report.js';
import { exportsAllOps } from './scenario.js';

const exec = promisify(execFile);
const TAG = '202611241200';
const BRANCH = 'ai-office/abc-m5';

/**
 * A throwaway local repository shaped like a finished preview: an integration
 * branch with core, mul, sub (path A: the worker merged the moved
 * integration branch in) and docs (`#pending` rework, merged from the worker's
 * last head). `origin/<integration>` is a local ref, so no network is used.
 */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'aio-t11b-facts-'));
  const run = async (...args: string[]) =>
    (await exec('git', ['-C', dir, ...args])).stdout.trim();
  const commit = async (file: string, text: string, message: string) => {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), text);
    await run('add', '-A');
    await run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  const merge = async (branch: string) => {
    await run('merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);
    return run('rev-parse', 'HEAD');
  };
  await run('init', '-q', '-b', 'main');
  await run('config', 'user.email', 't@example.invalid');
  await run('config', 'user.name', 't');
  const base = await commit('README', 'root\n', 'root');
  await run('checkout', '-q', '-b', 'int');
  const m = `m5/${TAG}`;
  // core
  await run('checkout', '-q', '-b', 'core', base);
  await commit(`${m}/calc.mjs`, 'export function add() {}\n', 'core');
  await run('checkout', '-q', 'int');
  const coreMerge = await merge('core');
  // mul and sub from the same base
  await run('checkout', '-q', '-b', 'mul', coreMerge);
  await commit(`${m}/mul.txt`, 'mul\n', 'mul');
  await run('checkout', '-q', '-b', 'sub', coreMerge);
  const subFirst = await commit(`${m}/sub.txt`, 'sub\n', 'sub');
  await run('checkout', '-q', 'int');
  const mulMerge = await merge('mul');
  // path A: the integrator merges the moved integration branch into sub
  await run('checkout', '-q', 'sub');
  const subResolved = await merge('int');
  await run('checkout', '-q', 'int');
  const subMerge = await merge('sub');
  // docs: first head #pending, second head with the PR number
  await run('checkout', '-q', '-b', 'docs', subMerge);
  const docsFirst = await commit(
    `${m}/README.md`,
    `# calc\n${PENDING_LINE}\n`,
    'docs 1',
  );
  const docsFinal = await commit(
    `${m}/README.md`,
    `# calc\n${reviewedLine(14)}\n`,
    'docs 2',
  );
  await run('checkout', '-q', 'int');
  const docsMerge = await merge('docs');
  await run('update-ref', `refs/remotes/origin/${BRANCH}`, 'int');
  const git: Git = (args) => run(...args);
  const log: Json[] = [];
  const add = (type: string, payload: Json) =>
    log.push({ seq: log.length + 1, type, payload });
  add('workflow.started', { integrationBranch: BRANCH });
  add('workitem.dispatched', { itemKey: 'core', baseSha: base });
  add('workitem.merged', {
    itemKey: 'core',
    pr: 11,
    mergeCommitSha: coreMerge,
  });
  add('workitem.dispatched', { itemKey: 'mul', baseSha: coreMerge });
  add('workitem.dispatched', { itemKey: 'sub', baseSha: coreMerge });
  add('workitem.merge_queued', { itemKey: 'mul', pr: 12, headSha: 'x' });
  add('workitem.merged', { itemKey: 'mul', pr: 12, mergeCommitSha: mulMerge });
  add('workitem.merge_queued', { itemKey: 'sub', pr: 13, headSha: subFirst });
  add('pr.status', { pr: 13, mergeable: false });
  add('workitem.merge_queued', {
    itemKey: 'sub',
    pr: 13,
    headSha: subResolved,
  });
  add('workitem.merged', { itemKey: 'sub', pr: 13, mergeCommitSha: subMerge });
  add('workitem.dispatched', { itemKey: 'docs', baseSha: subMerge });
  add('workitem.merge_queued', { itemKey: 'docs', pr: 14, headSha: docsFirst });
  add('workitem.rework_requested', { itemKey: 'docs', pr: 14 });
  add('workitem.merge_queued', { itemKey: 'docs', pr: 14, headSha: docsFinal });
  add('workitem.merged', {
    itemKey: 'docs',
    pr: 14,
    mergeCommitSha: docsMerge,
  });
  return { git, log, run, merges: [coreMerge, mulMerge, subMerge, docsMerge] };
}

describe('gitremote-equivalent facts', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => {
    w = await world();
  });

  it('reads implement first-parent merges in order', async () => {
    expect(await firstParents(w.git, w.log)).toEqual(w.merges);
  });

  it('checks every dependency merge against each dispatch base', async () => {
    const facts = await ancestry(w.git, w.log);
    const docsBase = w.merges[2]!;
    for (const commit of w.merges.slice(0, 3))
      expect(
        facts.find((f) => f.baseSha === docsBase && f.commit === commit)
          ?.isAncestor,
      ).toBe(true);
    // The docs merge is not in the core dispatch base.
    expect(
      facts.find((f) => f.commit === w.merges[3] && f.baseSha !== docsBase)
        ?.isAncestor,
    ).toBe(false);
  });

  it('finds the path-A two-parent merge on the conflicting PR', async () => {
    expect(await conflictFacts(w.git, w.log)).toEqual([
      { pr: 13, twoParentMerge: true },
    ]);
  });

  it('proves the #pending rework from the README heads and the merge parent', async () => {
    expect(await reworkFacts(w.git, w.log, TAG)).toEqual([
      {
        pr: 14,
        firstHeadHasPending: true,
        finalHeadHasPrNumber: true,
        lineByWorker: true,
      },
    ]);
  });

  it('counts stand-in objects per create commandId (keeper + duplicates)', async () => {
    const log = [
      {
        seq: 1,
        type: 'command.issued',
        payload: { kind: 'scm.createIssue', commandId: 'a' },
      },
      {
        seq: 2,
        type: 'command.issued',
        payload: { kind: 'scm.openPR', commandId: 'b' },
      },
      {
        seq: 3,
        type: 'command.issued',
        payload: { kind: 'scm.comment', commandId: 'c' },
      },
    ];
    const found: Record<string, { duplicates?: number } | null> = {
      a: {},
      b: { duplicates: 1 },
    };
    expect(await markerCounts(async (id) => found[id] ?? null, log)).toEqual({
      a: 1,
      b: 2,
    });
  });
});

describe('report pieces', () => {
  const log: Json[] = [
    {
      seq: 1,
      type: 'seat.spawned',
      payload: {
        attemptId: 'a1',
        stageId: 'implement',
        role: 'engineer',
        agent: 'codex',
        purpose: 'worker',
        itemKey: 'mul',
      },
    },
    {
      seq: 2,
      type: 'usage.tokens',
      payload: {
        attemptId: 'a1',
        inputUncached: 10,
        output: 5,
        cacheRead: 1,
        cacheWrite: 0,
        budgetTokens: 16,
      },
    },
    {
      seq: 3,
      type: 'usage.tokens',
      payload: {
        attemptId: 'a1',
        inputUncached: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        budgetTokens: 3,
      },
    },
    { seq: 4, type: 'usage.turns', payload: { attemptId: 'a1', turns: 2 } },
    {
      seq: 5,
      type: 'command.issued',
      payload: { commandId: 'm', kind: 'scm.mergePR' },
    },
    {
      seq: 6,
      type: 'command.reconciled',
      payload: { commandId: 'm', outcome: 'found' },
    },
  ];

  it('sums usage per attempt for T13 (numbers only)', () => {
    const ledger = usageLedger(log, TAG);
    expect(ledger.attempts).toEqual([
      expect.objectContaining({
        role: 'engineer',
        agent: 'codex',
        itemKey: 'mul',
        inputUncached: 12,
        output: 6,
        budgetTokens: 19,
        turns: 2,
        samples: 2,
      }),
    ]);
    expect(JSON.stringify(ledger)).not.toMatch(/body|session/);
  });

  it('names the side of the merge the kill landed on', () => {
    expect(killSide(log, 5)).toBe('after-merge');
    expect(killSide(log, undefined)).toBe('no-kill');
    const redone = log.map((e) =>
      e.type === 'command.reconciled'
        ? { ...e, payload: { ...e.payload, outcome: 'redone' } }
        : e,
    );
    expect(killSide(redone, 5)).toBe('before-merge');
    const settled = [
      ...log.slice(0, 5),
      { seq: 6, type: 'command.succeeded', payload: { commandId: 'm' } },
    ];
    expect(killSide(settled, 5)).toBe('settled-before-kill');
  });

  it('judges the §2.6 behaviours from the checker rows and the report', () => {
    const pass = {
      'v01.base-sha': 'pass',
      'v01.rework': 'pass',
      'v01.conflict': 'pass',
      'v01.oncall': 'pass',
      'nf.stage-gate-agents': 'pass',
    } as const;
    const items = ['core', 'mul', 'sub', 'docs'].map((itemKey, i) => ({
      seq: 100 + i,
      type: 'workitem.merged',
      payload: { itemKey },
    }));
    const done = [
      ...items,
      { seq: 200, type: 'gate.closed', payload: { reason: 'merged' } },
    ];
    const report = {
      status: 'completed',
      killed: true,
      trigger: 'K',
      assertions: [{ id: 1, status: 'pass' }],
      stageGates: [{ live: 0 }],
      owner: { escalation: { releasedBy: 'restart' } },
      escalationAnsweredByOwner: true,
    };
    const all = behaviours({
      log: done,
      report,
      rows: pass,
      conflictEvidence: ['PR #13 (sub): path A, …'],
      testsPass: true,
      bothOps: true,
    });
    expect(all.filter((b) => b.ok !== true)).toEqual([]);
    expect(all.find((b) => b.id === 'conflict-handled')?.evidence.path).toBe(
      'A',
    );
    const failing = behaviours({
      log: done,
      report: { ...report, assertions: [{ id: 2, status: 'fail' }] },
      rows: { ...pass, 'v01.rework': 'fail' },
      testsPass: false,
    });
    expect(
      failing
        .filter((b) => b.ok !== true)
        .map((b) => b.id)
        .sort(),
    ).toEqual([
      'conflict-handled',
      'restart-once-all-assertions',
      'rework-round-trip',
    ]);
  });

  it('recognizes calc.mjs exporting all three operations', () => {
    expect(
      exportsAllOps(
        'export function add(a, b) {}\n// ops:begin\nexport function mul(a, b) {}\nexport function sub(a, b) {}\n// ops:end\n',
      ),
    ).toBe(true);
    expect(exportsAllOps('export function add() {}\n// (no ops yet)\n')).toBe(
      false,
    );
  });
});
