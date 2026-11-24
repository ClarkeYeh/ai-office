import type { AcceptanceFacts } from './facts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped exported JSON
type Json = Record<string, any>;

/*
 * A compact m5-mainline-shaped log (M5_PLAN §2.2.1) that satisfies every
 * judged §9.1 row, for the checker's own tests: decision gates, an on-call
 * answer, `mul`/`sub` depending on `core`, a `#pending`-style rework of `mul`,
 * a forced conflict on `sub` resolved by the integrator (path A), usage with
 * enforcement off, and the final PR merged by the owner. Only the fields the
 * checker reads are filled in.
 */
export function syntheticMainline(): {
  events: Json[];
  facts: AcceptanceFacts;
} {
  const W = '01M5SYNTHETIC0000000000000';
  const events: Json[] = [];
  let ms = Date.parse('2026-11-24T00:00:00.000Z');
  const push = (type: string, payload: Json, envelope: Json = {}) => {
    ms += 1000;
    const seq = events.length + 1;
    events.push({
      seq,
      id: `01M5EVENT${String(seq).padStart(17, '0')}`,
      type,
      workflowId: W,
      source: 'engine',
      provenance: 'decided',
      schemaVersion: 1,
      occurredAt: new Date(ms).toISOString(),
      recordedAt: new Date(ms + 40).toISOString(),
      ...envelope,
      payload,
    });
  };
  const sha = (n: number) => n.toString(16).padStart(40, '0');
  let commands = 0;
  const command = (kind: string, args: Json, result: Json = {}) => {
    const commandId = `${W}/cmd/${++commands}`;
    push('command.issued', { commandId, kind, args });
    push('command.succeeded', { commandId, kind, result }, { source: 'scm' });
  };
  const spawn = (attemptId: string, purpose: string, extra: Json = {}) => {
    push('seat.spawned', { attemptId, purpose, ...extra });
    push(
      'seat.status',
      { attemptId, state: 'working' },
      { source: 'runtime', externalKey: `orca:${attemptId}:working` },
    );
  };
  const release = (attemptId: string) =>
    push('seat.released', { attemptId, removeWorkspace: true });
  const stageGate = (stageKind: string) => {
    const gateId = `${W}/${stageKind}/1/gate`;
    push('gate.opened', { gateId, kind: 'stage', stageKind });
    return gateId;
  };
  const merge = (itemKey: string, pr: number, n: number) => {
    command(
      'scm.mergePR',
      { pr: { repo: { owner: 'o', name: 'r' }, number: pr }, method: 'merge' },
      { mergeCommitSha: sha(n) },
    );
    push('workitem.merged', {
      itemKey,
      pr,
      mergeCommitSha: sha(n),
      commandId: `${W}/cmd/${commands}`,
    });
  };
  const usage = (attemptId: string, n: number) =>
    push(
      'usage.tokens',
      { attemptId, inputUncached: 10, output: 5, budgetTokens: 15 },
      { source: 'system', externalKey: `usage:${attemptId}:${n}` },
    );

  push('workflow.started', {
    shortId: 'syn1',
    integrationBranch: 'ai-office/syn1-calc',
    repo: { defaultBranch: 'main' },
    limits: { budgetEnforcement: 'off' },
  });
  for (const [stage, purpose] of [
    ['meeting', 'facilitator'],
    ['planning', 'planner'],
  ] as const) {
    spawn(`${W}/${stage}/lead`, purpose);
    usage(`${W}/${stage}/lead`, 1);
    release(`${W}/${stage}/lead`);
    const gateId = stageGate(stage);
    push('gate.decided', { gateId, decision: 'approve', by: 'user' });
  }
  push('workitem.approved', {
    gateId: `${W}/planning/1/gate`,
    items: [
      { key: 'core', deps: [] },
      { key: 'mul', deps: ['core'] },
      { key: 'sub', deps: ['core'] },
    ],
  });

  // core: asks on-call, waits, gets an answer; on-call then idles out.
  const core = `${W}/implement/core/1/attempt`;
  push('workitem.dispatched', {
    itemKey: 'core',
    attemptId: core,
    branch: 'ai-office/syn1/core',
    baseSha: sha(1),
  });
  spawn(core, 'worker', { itemKey: 'core' });
  push('message.question', { questionId: 'q1', attemptId: core });
  push(
    'seat.status',
    { attemptId: core, state: 'waiting_input' },
    { source: 'runtime', externalKey: `orca:${core}:waiting` },
  );
  const oncall = `${W}/implement/ondemand/oncall/1/attempt`;
  push('ondemand.started', { purpose: 'oncall', attemptId: oncall });
  spawn(oncall, 'oncall');
  push('message.forwarded', {
    questionId: 'q1',
    to: 'on-call',
    toAttemptId: oncall,
  });
  push('message.answered', {
    questionId: 'q1',
    by: 'agent',
    attemptId: oncall,
  });
  push('ondemand.stopped', {
    purpose: 'oncall',
    attemptId: oncall,
    reason: 'queue_empty',
  });
  release(oncall);
  usage(core, 1);
  command('scm.openPR', { head: 'ai-office/syn1/core' });
  push('artifact.created', { kind: 'pr', number: 10 });
  push('workitem.merge_queued', {
    itemKey: 'core',
    attemptId: core,
    pr: 10,
    headSha: sha(2),
  });
  const mergeQueue = `${W}/implement/ondemand/merge/1/attempt`;
  push('ondemand.started', { purpose: 'merge', attemptId: mergeQueue });
  spawn(mergeQueue, 'integrator');
  merge('core', 10, 3);
  release(core);

  // mul and sub start from core's merge commit.
  const mul = `${W}/implement/mul/1/attempt`;
  const sub = `${W}/implement/sub/1/attempt`;
  for (const [itemKey, attemptId, pr, head] of [
    ['mul', mul, 11, 4],
    ['sub', sub, 12, 5],
  ] as const) {
    push('workitem.dispatched', {
      itemKey,
      attemptId,
      branch: `ai-office/syn1/${itemKey}`,
      baseSha: sha(3),
    });
    spawn(attemptId, 'worker', { itemKey });
    usage(attemptId, 1);
    command('scm.openPR', { head: `ai-office/syn1/${itemKey}` });
    push('artifact.created', { kind: 'pr', number: pr });
    push('workitem.merge_queued', {
      itemKey,
      attemptId,
      pr,
      headSha: sha(head),
    });
    release(attemptId);
  }
  // mul: `#pending` → rework on the same branch and PR.
  push('workitem.rework_requested', {
    itemKey: 'mul',
    pr: 11,
    attemptId: mergeQueue,
    rework: 1,
  });
  const mul2 = `${W}/implement/mul/2/attempt`;
  push('workitem.dispatched', {
    itemKey: 'mul',
    attemptId: mul2,
    branch: 'ai-office/syn1/mul',
    baseSha: sha(4),
    reworkOf: 'submission-1',
  });
  spawn(mul2, 'worker', { itemKey: 'mul' });
  usage(mul2, 1);
  push('workitem.merge_queued', {
    itemKey: 'mul',
    attemptId: mul2,
    pr: 11,
    headSha: sha(6),
  });
  release(mul2);
  merge('mul', 11, 7);
  // sub conflicts with mul's merge; the integrator merges the moved branch in.
  push(
    'pr.status',
    { pr: 12, state: 'open', headSha: sha(5), mergeable: false },
    { source: 'scm', externalKey: 'gh:pr:12:1' },
  );
  merge('sub', 12, 8);
  push('ondemand.stopped', {
    purpose: 'merge',
    attemptId: mergeQueue,
    reason: 'queue_empty',
  });
  release(mergeQueue);
  push('stage.completed', { stageId: 'implement' });

  command('scm.openPR', { head: 'ai-office/syn1-calc', base: 'main' });
  push('artifact.created', { kind: 'pr', number: 20 });
  const finalGate = stageGate('final-pr');
  push('gate.closed', { gateId: finalGate, reason: 'merged' });
  push('workflow.completed', { finalPr: 20, mergeCommitSha: sha(9) });

  return {
    events,
    facts: {
      ancestry: [{ baseSha: sha(3), commit: sha(3), isAncestor: true }],
      rework: [
        {
          pr: 11,
          firstHeadHasPending: true,
          finalHeadHasPrNumber: true,
          lineByWorker: true,
        },
      ],
      conflict: [{ pr: 12, twoParentMerge: true }],
      integrationFirstParent: [sha(3), sha(7), sha(8)],
      markerScan: { maxObjectsPerCommand: 1 },
      workerListAtStageGates: ['meeting', 'planning', 'final-pr'].map(
        (kind) => ({ gateId: `${W}/${kind}/1/gate`, liveAgents: 0 }),
      ),
      defaultBranchMovedOnlyByOwner: true,
      approveCommentNoStateChange: true,
    },
  };
}
