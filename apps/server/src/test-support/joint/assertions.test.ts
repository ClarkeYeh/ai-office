import { describe, expect, it } from 'vitest';
import type { Json } from '../orca/t17/checks.js';
import {
  a1SingleInstance,
  a2InFlightCommands,
  a3NoDuplicateMerge,
  a4NoDuplicateCreate,
  a5NoDuplicateSpawnSend,
  a6MailboxExactlyOnce,
  a7IngestCursor,
  a8Submissions,
  a9Timers,
  a10ReachedFinalGate,
  a12Orca,
  a13Usage,
  a14Files,
  a15SseAndSession,
  a16Locks,
  a17InFlightSubmission,
  inFlightAtKill,
  restartAssertions,
  type RestartEvidence,
} from './assertions.js';
import type { RestartRecord } from './restart.js';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

/**
 * A synthetic healthy run: core merged, then sub's merge-request accepted and
 * its mergePR issued (K, seq 12), the kill, then the reconcile finds the merge.
 */
function healthyLog(): Json[] {
  const log: Json[] = [];
  const add = (type: string, payload: Json, extra: Json = {}) =>
    log.push({ seq: log.length + 1, type, payload, ...extra });
  add('command.issued', { commandId: 'open', kind: 'runtime.openSession' });
  add('command.succeeded', { commandId: 'open', kind: 'runtime.openSession' });
  add('seat.spawned', { attemptId: 'w-core', itemKey: 'core' });
  add(
    'command.issued',
    { commandId: 'sp1', kind: 'runtime.spawnAgent' },
    { attemptId: 'w-core' },
  );
  add('command.succeeded', { commandId: 'sp1', kind: 'runtime.spawnAgent' });
  add('workitem.merged', { itemKey: 'core', mergeCommitSha: SHA1 });
  add(
    'usage.tokens',
    {
      attemptId: 'w-core',
      inputUncached: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    },
    { externalKey: 'usage:w-core:1' },
  );
  add('message.question', { questionId: 'q1' }, { externalKey: 'orca:msg:m1' });
  add('command.issued', { commandId: 'pr', kind: 'scm.openPR' });
  add('command.succeeded', {
    commandId: 'pr',
    kind: 'scm.openPR',
    result: { pr: 7 },
  });
  add('submission.accepted', {
    submissionId: 's1',
    attemptId: 'mq',
    kind: 'merge-request',
    submission: {
      kind: 'merge-request',
      payload: { pr: 7, expectedHeadSha: SHA2 },
    },
  });
  add('command.issued', {
    commandId: 'merge7',
    kind: 'scm.mergePR',
    args: { pr: { number: 7 } },
  }); // seq 12: K
  // --- kill after seq 12; restart ---
  add('command.reconciled', {
    commandId: 'merge7',
    kind: 'scm.mergePR',
    outcome: 'found',
  });
  add('command.succeeded', {
    commandId: 'merge7',
    kind: 'scm.mergePR',
    result: { mergeCommitSha: SHA2 },
  });
  add('workitem.merged', { itemKey: 'sub', mergeCommitSha: SHA2 });
  add('gate.opened', { gateId: 'fin', kind: 'stage', stageKind: 'final-pr' });
  add('workitem.merge_queued', { itemKey: 'sub', pr: 7, attemptId: 'w-sub' });
  return log;
}

const record: RestartRecord = {
  trigger: 'K',
  triggerSeq: 12,
  oldPid: 100,
  newPid: 200,
  restartIssuedMs: 1_000,
  readyMs: 10_000,
  downtimeMs: 11_000,
  oldPidAliveAfter: false,
  runtimePidAfter: 200,
  withinBudget: true,
  readyAt: 0,
};

function healthy(): RestartEvidence {
  const events = healthyLog();
  return {
    events,
    restart: record,
    killSeq: 12,
    orphans: { before: 2, aliveAfterRestart: 0 },
    scm: {
      integrationFirstParents: [SHA1, SHA2],
      markerCounts: { 'cmd-a': 1, 'cmd-b': 1 },
    },
    orca: {
      inbox: [
        { id: 'm1', sequence: 4 },
        { id: 'm2', sequence: 5 },
      ],
      classified: ['m2'],
      runtimeCursorLastSeq: 5,
      shimHandles: { before: ['shim1'], after: ['shim1'] },
      runs: 1,
      worktreeNames: ['aio-x-core', 'aio-x-sub'],
      consumerGenerationChanges: 0,
      reclaims: 0,
      dispatches: ['d1'],
    },
    files: {
      controlTokenRotated: true,
      oldControlTokenStatus: 401,
      caffeinateForNewPid: true,
    },
    session: { oldCookieStatus: 200, openSessionStatus: 200 },
    sse: { seqs: events.map((e) => e.seq as number), reconnects: 1 },
    locks: { github: [true, true], orca: [true, true] },
  };
}

const push = (
  x: RestartEvidence,
  type: string,
  payload: Json,
  extra: Json = {},
) => x.events.push({ seq: x.events.length + 1, type, payload, ...extra });

describe('restart assertions on a healthy synthetic run', () => {
  it('every row passes and #11 is left to T17', () => {
    const rows = restartAssertions(healthy());
    expect(rows.map((r) => r.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17,
    ]);
    expect(rows.filter((r) => r.status !== 'pass')).toEqual([]);
  });

  it('missing observations are n/a, never a pass', () => {
    const rows = restartAssertions({ events: [] });
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    for (const id of [1, 9, 14, 16, 17]) expect(byId.get(id)).toBe('n/a');
    // #10 always has event evidence: no final gate is a failure.
    expect(byId.get(10)).toBe('fail');
  });

  it('finds the commands in flight at the kill', () => {
    expect(inFlightAtKill(healthyLog(), 12)).toEqual(['merge7']);
    expect(inFlightAtKill(healthyLog(), 14)).toEqual([]);
  });
});

describe('each row fails on its own defect', () => {
  it('#1 old pid alive, runtime.json stale or orphan check groups', () => {
    const x = healthy();
    x.restart = { ...record, oldPidAliveAfter: true };
    expect(a1SingleInstance(x).status).toBe('fail');
    x.restart = { ...record, runtimePidAfter: 100 };
    expect(a1SingleInstance(x).status).toBe('fail');
    x.restart = record;
    x.orphans = { before: 2, aliveAfterRestart: 1 };
    expect(a1SingleInstance(x).status).toBe('fail');
  });

  it('#2 a missing reconcile, a double result or gave_up', () => {
    const x = healthy();
    x.events = x.events.filter((e) => e.type !== 'command.reconciled');
    expect(a2InFlightCommands(x).detail.unreconciled).toBe(1);
    expect(a2InFlightCommands(x).status).toBe('fail');
    const y = healthy();
    push(y, 'command.failed', { commandId: 'merge7', kind: 'scm.mergePR' });
    expect(a2InFlightCommands(y).detail.badResults).toBe(1);
    const z = healthy();
    push(z, 'command.reconciled', {
      commandId: 'zz',
      kind: 'scm.comment',
      outcome: 'gave_up',
    });
    expect(a2InFlightCommands(z).status).toBe('fail');
    const w = healthy();
    w.events = w.events.map((e) =>
      e.type === 'command.succeeded' && e.payload.commandId === 'merge7'
        ? { ...e, type: 'command.failed' }
        : e,
    );
    expect(a2InFlightCommands(w).detail.foundWithoutSuccess).toBe(1);
  });

  it('#3 a second merge of one PR or a foreign first-parent commit', () => {
    const x = healthy();
    push(x, 'command.issued', {
      commandId: 'merge7b',
      kind: 'scm.mergePR',
      args: { pr: { number: 7 } },
    });
    push(x, 'command.succeeded', { commandId: 'merge7b', kind: 'scm.mergePR' });
    expect(a3NoDuplicateMerge(x).detail.prsMergedTwice).toBe(1);
    const y = healthy();
    y.scm!.integrationFirstParents = [SHA1, 'c'.repeat(40), SHA2];
    expect(a3NoDuplicateMerge(y).status).toBe('fail');
    const z = healthy();
    push(z, 'workitem.merged', {
      itemKey: 'sub',
      mergeCommitSha: 'd'.repeat(40),
    });
    expect(a3NoDuplicateMerge(z).status).toBe('fail');
  });

  it('#4 two objects for one commandId or an unconverged duplicate', () => {
    const x = healthy();
    x.scm!.markerCounts!['cmd-a'] = 2;
    expect(a4NoDuplicateCreate(x).status).toBe('fail');
    const y = healthy();
    push(y, 'anomaly.detected', {
      kind: 'duplicate-object',
      severity: 'warning',
    });
    expect(a4NoDuplicateCreate(y).status).toBe('fail');
    y.scm!.duplicatesConverged = true;
    expect(a4NoDuplicateCreate(y).status).toBe('pass');
  });

  it('#5 a repeated send, a second spawn or our dispatch unmanaged', () => {
    const x = healthy();
    for (let i = 0; i < 2; i++)
      push(
        x,
        'command.issued',
        { commandId: `s${i}`, kind: 'runtime.send', args: { subject: 'core' } },
        { attemptId: 'w-core' },
      );
    expect(a5NoDuplicateSpawnSend(x).detail.repeatedSends).toBe(1);
    const y = healthy();
    push(
      y,
      'command.issued',
      { commandId: 'sp2', kind: 'runtime.spawnAgent' },
      { attemptId: 'w-core' },
    );
    expect(a5NoDuplicateSpawnSend(y).status).toBe('fail');
    const z = healthy();
    push(z, 'agent.unmanaged', { dispatch: 'd1' });
    expect(a5NoDuplicateSpawnSend(z).status).toBe('fail');
  });

  it('#6 an unmatched or doubly ingested inbox message', () => {
    const x = healthy();
    x.orca!.classified = [];
    expect(a6MailboxExactlyOnce(x).detail.unmatched).toBe(1);
    const y = healthy();
    y.orca!.classified = ['m1', 'm2'];
    expect(a6MailboxExactlyOnce(y).detail.doubled).toBe(1);
    const z = healthy();
    push(z, 'message.question', { questionId: 'q1' });
    expect(a6MailboxExactlyOnce(z).detail.duplicatedFacts).toBe(1);
  });

  it('#7 a lagging runtime cursor or a repeated gh: key', () => {
    const x = healthy();
    x.orca!.runtimeCursorLastSeq = 4;
    expect(a7IngestCursor(x).status).toBe('fail');
    const y = healthy();
    push(y, 'pr.status', {}, { externalKey: 'gh:pr:7:1' });
    push(y, 'pr.status', {}, { externalKey: 'gh:pr:7:1' });
    expect(a7IngestCursor(y).status).toBe('fail');
  });

  it('#8 a resent merge-request accepted twice', () => {
    const x = healthy();
    push(x, 'submission.accepted', {
      submissionId: 's2',
      attemptId: 'mq',
      kind: 'merge-request',
      submission: {
        kind: 'merge-request',
        payload: { pr: 7, expectedHeadSha: SHA2 },
      },
    });
    expect(a8Submissions(x).detail.repeatedMergeRequests).toBe(1);
    expect(a8Submissions(x).status).toBe('fail');
  });

  it('#9 a nudge or spawn-stall gate during the downtime; waiter timeouts', () => {
    const x = healthy();
    push(x, 'message.nudge', { attemptId: 'w-core', reason: 'item-timeout' });
    expect(a9Timers(x).status).toBe('fail');
    const y = healthy();
    push(y, 'gate.opened', { exceptionKind: 'spawn-stall' });
    expect(a9Timers(y).status).toBe('fail');
    // Outside the window (after the restart settled) it is not this row's concern.
    expect(a9Timers(y, { settleSeq: 16 }).status).toBe('pass');
    const z = healthy();
    expect(a9Timers(z).detail.waiterQuestionTimeouts).toBe('n/a');
    push(z, 'message.nudge', {
      attemptId: 'w-name',
      reason: 'question-timeout',
    });
    expect(
      a9Timers(z, { heldQuestionAttempt: 'w-name', settleSeq: 16 }).status,
    ).toBe('fail');
  });

  it('#10 an anomaly gate after the kill', () => {
    const x = healthy();
    push(x, 'gate.opened', { exceptionKind: 'anomaly' });
    expect(a10ReachedFinalGate(x).status).toBe('fail');
  });

  it('#12 a new shim, a second run, openSession or hijack, duplicate worktree', () => {
    const cases: ((x: RestartEvidence) => void)[] = [
      (x) =>
        (x.orca!.shimHandles = {
          before: ['shim1'],
          after: ['shim1', 'shim2'],
        }),
      (x) => (x.orca!.runs = 2),
      (x) =>
        push(x, 'command.issued', {
          commandId: 'open2',
          kind: 'runtime.openSession',
        }),
      (x) => push(x, 'runtime.identity_hijacked', { run: 'r' }),
      (x) => (x.orca!.worktreeNames = ['aio-x-core', 'aio-x-core']),
      (x) => (x.orca!.consumerGenerationChanges = 1),
    ];
    for (const breakIt of cases) {
      const x = healthy();
      breakIt(x);
      expect(a12Orca(x).status).toBe('fail');
    }
    const ok = healthy();
    ok.orca!.consumerGenerationChanges = 1;
    ok.orca!.reclaims = 1; // our own reclaim explains it
    expect(a12Orca(ok).status).toBe('pass');
  });

  it('#13 a repeated usage key or a negative delta', () => {
    const x = healthy();
    push(
      x,
      'usage.tokens',
      { attemptId: 'w-core', output: 1 },
      { externalKey: 'usage:w-core:1' },
    );
    expect(a13Usage(x).status).toBe('fail');
    const y = healthy();
    push(
      y,
      'usage.tokens',
      { attemptId: 'w-core', output: -1 },
      { externalKey: 'usage:w-core:2' },
    );
    expect(a13Usage(y).detail.negativeDeltas).toBe(1);
  });

  it('#14 token not rotated, old token accepted, no caffeinate', () => {
    for (const files of [
      { controlTokenRotated: false },
      { oldControlTokenStatus: 200 },
      { caffeinateForNewPid: false },
    ]) {
      const x = healthy();
      x.files = { ...x.files, ...files };
      expect(a14Files(x).status).toBe('fail');
    }
    const partial = healthy();
    partial.files = {}; // T6 not merged / preventSleep off: only the pid part
    expect(a14Files(partial).status).toBe('pass');
  });

  it('#15 an expired cookie, an SSE gap or duplicate, a failed open session', () => {
    const x = healthy();
    x.session = { oldCookieStatus: 401 };
    expect(a15SseAndSession(x).status).toBe('fail');
    const gap = healthy();
    gap.sse = { seqs: gap.sse!.seqs.filter((n) => n !== 13), reconnects: 1 };
    expect(a15SseAndSession(gap).detail.sseGaps).toBe(1);
    const dup = healthy();
    dup.sse = { seqs: [...dup.sse!.seqs, 13], reconnects: 1 };
    expect(a15SseAndSession(dup).detail.sseDuplicates).toBe(1);
    const noReconnect = healthy();
    noReconnect.sse = { ...noReconnect.sse!, reconnects: 0 };
    expect(a15SseAndSession(noReconnect).status).toBe('fail');
    const open = healthy();
    open.session = { oldCookieStatus: 200, openSessionStatus: 401 };
    expect(a15SseAndSession(open).status).toBe('fail');
  });

  it('#16 a lock sample not held', () => {
    const x = healthy();
    x.locks = { github: [true, false], orca: [true] };
    expect(a16Locks(x).status).toBe('fail');
  });

  it('#17 (revised) the in-flight merge-request', () => {
    const ok = a17InFlightSubmission(healthy());
    expect(ok.status).toBe('pass');
    expect(ok.detail).toMatchObject({
      pr: 7,
      acceptedForPr: 1,
      acceptedBeforeKill: 1,
      reconciledAfterKill: true,
      mergeSucceededAfterKill: 1,
      singleFirstParentMerge: true,
    });
    const mergeRequest = (submissionId: string) => ({
      submissionId,
      attemptId: 'mq',
      kind: 'merge-request',
      submission: {
        kind: 'merge-request',
        payload: { pr: 7, expectedHeadSha: SHA1 },
      },
    });
    // A second acceptance (here after the kill) fails (a').
    const twice = healthy();
    push(twice, 'submission.accepted', mergeRequest('s3'));
    expect(a17InFlightSubmission(twice).status).toBe('fail');
    // No merge outcome after the kill.
    const lost = healthy();
    lost.events = lost.events.filter(
      (e) =>
        !(
          (e.type === 'command.succeeded' &&
            e.payload.commandId === 'merge7') ||
          e.type === 'command.reconciled' ||
          (e.type === 'workitem.merged' && e.payload.itemKey === 'sub')
        ),
    );
    expect(a17InFlightSubmission(lost).detail.itemMergedAfterKill).toBe(0);
    expect(a17InFlightSubmission(lost).status).toBe('fail');
    // workitem.merged alone is an accepted outcome.
    const merged = healthy();
    merged.events = merged.events.filter(
      (e) => e.type !== 'command.reconciled',
    );
    expect(a17InFlightSubmission(merged).status).toBe('pass');
    // A second merge commit for the PR on the first-parent history.
    const doubled = healthy();
    doubled.scm!.integrationFirstParents = [SHA1, SHA2, SHA2];
    expect(a17InFlightSubmission(doubled).status).toBe('fail');
    // (b) a duplicated submission id fails even on K′, where (a') is n/a.
    const kPrime = healthy();
    kPrime.restart = { ...record, trigger: "K'" };
    expect(a17InFlightSubmission(kPrime).status).toBe('pass');
    expect(a17InFlightSubmission(kPrime).detail.inFlightSubmission).toBe('n/a');
    push(kPrime, 'submission.accepted', mergeRequest('s1'));
    expect(a17InFlightSubmission(kPrime).status).toBe('fail');
  });
});
