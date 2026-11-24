import { describe, expect, it } from 'vitest';
import type { Json } from '../orca/t17/checks.js';
import { OwnerPolicyExecutor, type OwnerPort } from './owner-policy.js';
import {
  CODE_NAME,
  ESCALATION_HOLD_MAX_MS,
  reviseEdits,
} from './scenario/index.js';

const TAG = '202611241200';

/** A fake backend: gates are mutable rows; every port call is recorded. */
function fakePort(
  options: {
    comment?: boolean;
    commentPosted?: boolean;
    workItems?: unknown;
  } = {},
) {
  const gates: Json[] = [];
  const calls: { op: string; [k: string]: unknown }[] = [];
  const port: OwnerPort = {
    openGates: async () => gates.filter((g) => g.status === 'open'),
    gateDetail: async (gateId) => ({
      gateId,
      workItems: options.workItems,
    }),
    decide: async (gate, body) => {
      calls.push({ op: 'decide', gateId: gate.gateId, body });
      gate.status = 'closed';
      return { status: 200 };
    },
    answer: async (questionId, body) => {
      calls.push({ op: 'answer', questionId, body });
      return { status: 202 };
    },
    ...(options.comment === false
      ? {}
      : {
          ownerApproveComment: async () => {
            calls.push({ op: 'comment' });
            return options.commentPosted ?? true;
          },
        }),
    handOff: async (status) => {
      calls.push({ op: 'handOff', status });
    },
    finalPr: async (gate) => {
      calls.push({ op: 'finalPr', gateId: gate.gateId });
    },
  };
  const add = (gate: Json) => {
    gates.push({ status: 'open', version: 1, ...gate });
    return gates.at(-1)!;
  };
  return { port, calls, add, gates };
}

const stage = (gateId: string, stageKind: string) => ({
  gateId,
  kind: 'stage',
  stageKind,
});
const exception = (
  gateId: string,
  exceptionKind: string,
  extra: Json = {},
) => ({
  gateId,
  kind: 'exception',
  exceptionKind,
  ...extra,
});

describe('conclusion gate', () => {
  it('posts the owner /approve first, then approves when nothing moved', async () => {
    const f = fakePort();
    f.add(stage('g1', 'meeting'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    expect(await x.step()).toEqual([]);
    expect(f.calls).toEqual([{ op: 'comment' }]);
    expect(await x.step()).toEqual(['approve-conclusion']);
    expect(f.calls[1]).toEqual({
      op: 'decide',
      gateId: 'g1',
      body: { decision: 'approve' },
    });
    expect(x.record).toMatchObject({
      conclusionApproved: 1,
      approveCommentNoEffect: true,
    });
  });

  it('flags the /approve comment when the gate changed after it', async () => {
    const f = fakePort();
    const gate = f.add(stage('g1', 'meeting'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    await x.step();
    gate.version = 2; // the comment moved the gate: a §24 safety finding
    await x.step();
    expect(x.record.approveCommentNoEffect).toBe(false);
    expect(x.record.conclusionApproved).toBe(1);
  });

  it('approves at once when no conclusion Issue was found to comment on', async () => {
    const f = fakePort({ commentPosted: false });
    f.add(stage('g1', 'meeting'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    expect(await x.step()).toEqual(['approve-conclusion']);
    expect(f.calls.map((c) => c.op)).toEqual(['comment', 'decide']);
    // No comment was posted: there is nothing to judge.
    expect(x.record.approveCommentNoEffect).toBe('n/a');
  });

  it('approves at once without a real Issue (T11b)', async () => {
    const f = fakePort({ comment: false });
    f.add(stage('g1', 'meeting'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    expect(await x.step()).toEqual(['approve-conclusion']);
    expect(x.record.approveCommentNoEffect).toBe('n/a');
  });
});

describe('task-split gate', () => {
  it('approves a split that matches §2.2.1', async () => {
    const f = fakePort({ workItems: reviseEdits(TAG).items });
    f.add(stage('g2', 'planning'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    expect(await x.step()).toEqual(['approve-split']);
    expect(f.calls[0]!.body).toEqual({ decision: 'approve' });
  });

  it('revises any other split to the scenario items', async () => {
    const f = fakePort({ workItems: [{ key: 'only-one' }] });
    f.add(stage('g2', 'planning'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    expect(await x.step()).toEqual(['revise-split']);
    expect(f.calls[0]!.body).toEqual({
      decision: 'revise',
      edits: reviseEdits(TAG),
    });
    expect(x.record.splitRevised).toBe(1);
  });
});

describe('escalated code-name question (held answer)', () => {
  const escalation = (gateId = 'q1', itemKey = 'name') =>
    exception(gateId, 'question-escalation', {
      questionId: `${gateId}-question`,
      content: { itemKey },
    });

  it('holds until the restart is ready, then answers Birch', async () => {
    let now = 0;
    const f = fakePort();
    f.add(escalation());
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG, now: () => now });
    expect(await x.step()).toEqual([]);
    now = 60_000;
    expect(await x.step()).toEqual([]); // still held
    x.restartReady(90_000);
    now = 90_000;
    expect(await x.step()).toEqual(['hold-answer']);
    expect(f.calls).toEqual([
      { op: 'answer', questionId: 'q1-question', body: CODE_NAME },
    ]);
    expect(x.record.escalation).toMatchObject({
      openedAt: 0,
      answeredAt: 90_000,
      releasedBy: 'restart',
    });
  });

  it('releases after 10 minutes when no restart came', async () => {
    let now = 5_000;
    const f = fakePort();
    f.add(escalation());
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG, now: () => now });
    await x.step();
    now = 5_000 + ESCALATION_HOLD_MAX_MS - 1;
    expect(await x.step()).toEqual([]);
    now = 5_000 + ESCALATION_HOLD_MAX_MS;
    expect(await x.step()).toEqual(['hold-answer']);
    expect(x.record.escalation?.releasedBy).toBe('timeout');
  });

  it('answers at once when the escalation opens after the restart', async () => {
    const f = fakePort();
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG, now: () => 50_000 });
    x.restartReady(10_000);
    f.add(escalation());
    expect(await x.step()).toEqual(['hold-answer']);
  });

  it('hands off a second escalation and one for another item', async () => {
    const f = fakePort();
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG, now: () => 0 });
    f.add(escalation('q1'));
    await x.step(); // held
    f.add(escalation('q2'));
    f.add(escalation('q3', 'core'));
    expect(await x.step()).toEqual(['hand-off', 'hand-off']);
    expect(x.record.handOffs.map((h) => h.gateId)).toEqual(['q2', 'q3']);
    expect(f.calls.filter((c) => c.op === 'answer')).toEqual([]);
  });

  it('finds the asking item through the question when the gate lacks it', async () => {
    const f = fakePort();
    f.port.questionItem = async (questionId) =>
      questionId === 'qn-question' ? 'name' : 'core';
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG, now: () => 0 });
    x.restartReady(0);
    f.add(
      exception('qn', 'question-escalation', { questionId: 'qn-question' }),
    );
    expect(await x.step()).toEqual(['hold-answer']);
    f.add(
      exception('qc', 'question-escalation', { questionId: 'qc-question' }),
    );
    expect(await x.step()).toEqual(['hand-off']);
  });

  it('hands off an escalation without a question id', async () => {
    const f = fakePort();
    f.add(
      exception('q9', 'question-escalation', { content: { itemKey: 'name' } }),
    );
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG, now: () => 0 });
    x.restartReady(0);
    expect(await x.step()).toEqual(['hold-answer']);
    expect(x.record.handOffs).toEqual([
      { gateId: 'q9', reason: 'escalation without questionId' },
    ]);
  });
});

describe('auto exception options (once each)', () => {
  it.each([
    ['merge-blocked', 'retry'],
    ['rework-limit', 'rework'],
    ['spawn-stall', 'retry'],
  ])('%s → %s once, then hand-off', async (kind, optionId) => {
    const f = fakePort();
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    f.add(exception('e1', kind));
    expect(await x.step()).toEqual(['option']);
    expect(f.calls[0]!.body).toEqual({ decision: 'option', optionId });
    f.add(exception('e2', kind));
    expect(await x.step()).toEqual(['hand-off']);
    expect(x.record.exceptions[kind]).toBe(1);
    expect(f.calls.at(-1)).toMatchObject({
      op: 'handOff',
      status: { phase: 'needs-decision', exceptionKind: kind },
    });
  });

  it('hands off any other exception and unknown stage gates', async () => {
    const f = fakePort();
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    f.add(exception('e1', 'anomaly'));
    f.add(stage('s1', 'something-else'));
    expect(await x.step()).toEqual(['hand-off', 'hand-off']);
    expect(f.calls.every((c) => c.op === 'handOff')).toBe(true);
  });

  it('a 409 is retried at the next version, other failures throw', async () => {
    const f = fakePort();
    let status = 409;
    f.port.decide = async (gate) => {
      f.calls.push({ op: 'decide', gateId: gate.gateId });
      return { status };
    };
    const gate = f.add(exception('e1', 'merge-blocked'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    await x.step();
    gate.version = 2;
    status = 500;
    await expect(x.step()).rejects.toThrow('gate decision 500');
  });
});

describe('final-PR gate', () => {
  it('is never decided: the port is told once (owner merge or stand-in)', async () => {
    const f = fakePort();
    const gate = f.add(stage('fin', 'final-pr'));
    const x = new OwnerPolicyExecutor(f.port, { tag: TAG });
    expect(await x.step()).toEqual(['await-owner-merge']);
    gate.version = 2; // a content update re-lists it
    await x.step();
    expect(f.calls).toEqual([{ op: 'finalPr', gateId: 'fin' }]);
    expect(f.calls.some((c) => c.op === 'decide')).toBe(false);
    expect(x.record.finalGate).toBe('fin');
  });
});
