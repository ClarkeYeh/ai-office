import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Json } from '../orca/t17/checks.js';
import {
  afterMerge,
  conclusionIssue,
  identityChecks,
  implementFirstParents,
  policyHits,
  runPrs,
  type GithubReads,
} from './production-checks.js';
import { holdFor } from './run.js';

const NOREPLY = '1+ClarkeYeh@users.noreply.github.com';

/** A finished run: two worker PRs, one Issue, the final PR, the owner's merge. */
function log(): Json[] {
  const out: Json[] = [];
  const add = (type: string, payload: Json) =>
    out.push({ seq: out.length + 1, type, payload });
  add('workflow.started', { integrationBranch: 'ai-office/abc-m5' });
  add('command.issued', { commandId: 'i1', kind: 'scm.createIssue', args: {} });
  add('command.succeeded', {
    commandId: 'i1',
    kind: 'scm.createIssue',
    result: { issue: 10 },
  });
  add('workitem.dispatched', { itemKey: 'core', branch: 'ai-office/abc/core' });
  add('command.issued', {
    commandId: 'p1',
    kind: 'scm.openPR',
    args: { base: 'ai-office/abc-m5' },
  });
  add('command.succeeded', {
    commandId: 'p1',
    kind: 'scm.openPR',
    result: { pr: 11 },
  });
  add('workitem.merged', { itemKey: 'core', mergeCommitSha: 'm1' });
  add('command.issued', {
    commandId: 'p2',
    kind: 'scm.openPR',
    args: { base: 'main' },
  });
  add('command.succeeded', {
    commandId: 'p2',
    kind: 'scm.openPR',
    result: { pr: 12 },
  });
  add('gate.opened', { gateId: 'fin', kind: 'stage', stageKind: 'final-pr' });
  add('seat.spawned', { attemptId: 'w', purpose: 'worker', agent: 'codex' });
  add('seat.policy_violation', {
    attemptId: 'w',
    hits: [{ rule: 'gh-api', severity: 'high' }],
  });
  add('pr.status', { pr: 12, state: 'merged', mergedBy: 'ClarkeYeh' });
  add('gate.closed', { gateId: 'fin', reason: 'merged' });
  add('workflow.completed', { mergeCommitSha: 'f1' });
  return out;
}

function api(overrides: Partial<Record<string, unknown>> = {}): GithubReads {
  const data: Record<string, unknown> = {
    '/issues/10': { user: { login: 'ClarkeYeh' } },
    '/issues/11': { user: { login: 'ClarkeYeh' } },
    '/issues/12': { user: { login: 'ClarkeYeh' } },
    '/pulls/11/commits': [
      { commit: { author: { email: NOREPLY }, committer: { email: NOREPLY } } },
    ],
    '/pulls/11/files': [{ filename: 'm5/x/calc.mjs' }],
    '/activity?per_page=100': [
      { ref: 'refs/heads/ai-office/abc/core', actor: { login: 'ClarkeYeh' } },
      { ref: 'refs/heads/other', actor: { login: 'someone' } },
    ],
    ...overrides,
  };
  return {
    request: async (_m, path) => ({ status: 200, data: data[path] as Json }),
    list: async (path) => (data[path] ?? []) as Json[],
  };
}

describe('M5-T12 production checks', () => {
  it('splits worker PRs, the final PR and Issues from the log', () => {
    expect(runPrs(log())).toEqual({ workers: [11], final: 12, issues: [10] });
  });

  it('passes identity when the owner made everything with the noreply identity', async () => {
    const result = await identityChecks(api(), log(), {
      owner: 'ClarkeYeh',
      noreplyEmail: NOREPLY,
    });
    expect(result).toMatchObject({
      ok: true,
      objectAuthors: ['ClarkeYeh'],
      agentCommits: { commits: 1, authorNoreply: 1, committerNoreply: 1 },
      pushes: { count: 1, actors: ['ClarkeYeh'] },
      githubPathsTouched: 0,
    });
    // The email is compared, never reported.
    expect(JSON.stringify(result)).not.toContain('noreply');
  });

  it.each([
    ['a foreign author', { '/issues/12': { user: { login: 'bot' } } }],
    [
      'a non-noreply commit',
      {
        '/pulls/11/commits': [
          {
            commit: {
              author: { email: 'x@y.z' },
              committer: { email: NOREPLY },
            },
          },
        ],
      },
    ],
    [
      'a .github change',
      { '/pulls/11/files': [{ filename: '.github/workflows/ci.yml' }] },
    ],
    [
      'a foreign push',
      {
        '/activity?per_page=100': [
          { ref: 'refs/heads/ai-office/abc-m5', actor: { login: 'bot' } },
        ],
      },
    ],
    ['no push seen', { '/activity?per_page=100': [] }],
  ])('fails identity on %s', async (_name, overrides) => {
    const result = await identityChecks(api(overrides), log(), {
      owner: 'ClarkeYeh',
      noreplyEmail: NOREPLY,
    });
    expect(result.ok).toBe(false);
  });

  it('reports policy hits by purpose and agent', () => {
    expect(policyHits(log())).toEqual([
      { rule: 'gh-api', severity: 'high', by: 'worker/codex' },
    ]);
  });

  it('checks what must follow the hand merge', () => {
    expect(afterMerge(log(), { owner: 'ClarkeYeh' })).toMatchObject({
      ok: true,
      finalPr: 12,
      merged: true,
      mergedByOwner: true,
      gateClosedMerged: true,
      workflowCompleted: true,
      cleanupFailed: 0,
    });
    const bad = log();
    bad.push({
      seq: 99,
      type: 'anomaly.detected',
      payload: { kind: 'cleanup-failed' },
    });
    expect(afterMerge(bad, { owner: 'ClarkeYeh' })).toMatchObject({
      ok: false,
      cleanupFailed: 1,
      anomaliesAfterMerge: ['cleanup-failed'],
    });
    expect(afterMerge(log(), { owner: 'someone-else' }).ok).toBe(false);
  });

  it('finds the conclusion Issue by its gate stage, not by creation order', () => {
    const wf = '01M8643EBKGJ4SAKJJ1JZVMWSN';
    const events: Json[] = [];
    const add = (type: string, payload: Json) =>
      events.push({ seq: events.length + 1, type, payload });
    // An item Issue created first (e.g. a replayed or reordered run).
    add('command.succeeded', {
      commandId: `${wf}/breakdown/1/issue/core`,
      kind: 'scm.createIssue',
      result: { issue: 2 },
    });
    add('command.succeeded', {
      commandId: `${wf}/meeting/1/issue`,
      kind: 'scm.createIssue',
      result: { issue: 7 },
    });
    expect(conclusionIssue(events)).toBeUndefined(); // no conclusion gate yet
    add('gate.opened', {
      gateId: `${wf}/meeting/1/gate`,
      stageId: 'meeting',
      kind: 'stage',
      content: { type: 'conclusion', artifactId: 'a1' },
    });
    expect(conclusionIssue(events)).toBe(7);
    // A rerun's Issue of the same stage still matches (`/<n>/issue`).
    const rerun = events.map((e) =>
      e.payload.commandId === `${wf}/meeting/1/issue`
        ? {
            ...e,
            payload: { ...e.payload, commandId: `${wf}/meeting/2/issue` },
          }
        : e,
    );
    expect(conclusionIssue(rerun)).toBe(7);
  });

  it('keeps implement merges only on the first-parent chain', () => {
    expect(implementFirstParents(['m1', 'wrap'], log())).toEqual(['m1']);
  });
});

describe('owner / coordinator hand-off file', () => {
  it('writes the status privately and returns once the matching decision appears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-t12-hold-'));
    const status = join(dir, 'status.json');
    const pending = holdFor(
      status,
      { phase: 't17-live', for: 't17-live' },
      5_000,
      10,
    );
    await new Promise((r) => setTimeout(r, 30));
    await writeFile(
      `${status}.decision.json`,
      JSON.stringify({ for: 'other' }),
    );
    await new Promise((r) => setTimeout(r, 30));
    await writeFile(
      `${status}.decision.json`,
      JSON.stringify({ for: 't17-live' }),
    );
    await expect(pending).resolves.toBe('done');
  });

  it('times out without a decision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-t12-hold-'));
    await expect(
      holdFor(join(dir, 'status.json'), { for: 'x' }, 40, 10),
    ).resolves.toBe('timeout');
  });
});
