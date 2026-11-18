import { expect, test } from 'vitest';
import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import { evolve, replay, PROJECTION_VERSION } from './index.js';
import { event, payloads } from './test-support/events.js';
import { scenario } from './test-support/scenario.js';

test.each(['oncall', 'merge'] as const)(
  '%s instance lifecycle preserves independent queues and attempt history',
  (purpose) => {
    const s = scenario();
    const other = purpose === 'merge' ? 'oncall' : 'merge';
    s.push('seat.spawned', {
      ...payloads['seat.spawned'],
      purpose: purpose === 'merge' ? 'integrator' : 'oncall',
      ondemand: { purpose },
    });
    s.push('ondemand.started', {
      stageId: 'implement',
      purpose,
      attemptId: 'a1',
    });
    s.push('ondemand.queue_changed', {
      stageId: 'implement',
      purpose,
      queue: ['second', 'third'],
      current: 'first',
    });
    expect(s.model.stages[2]?.ondemand?.[purpose]).toEqual({
      active: true,
      attemptId: 'a1',
      queue: ['second', 'third'],
      current: 'first',
    });
    expect(s.model.stages[2]?.ondemand?.[other]).toEqual({
      active: false,
      queue: [],
    });
    expect(s.model.seats[0]?.attempts[0]?.ondemand).toEqual({ purpose });
    s.push('ondemand.started', {
      stageId: 'implement',
      purpose,
      attemptId: 'a2',
    });
    s.push('ondemand.stopped', {
      stageId: 'implement',
      purpose,
      attemptId: 'a1',
      reason: 'failed',
    });
    expect(s.model.stages[2]?.ondemand?.[purpose]?.active).toBe(true);
    s.push('ondemand.queue_changed', {
      stageId: 'implement',
      purpose,
      queue: ['second'],
    });
    expect(s.model.stages[2]?.ondemand?.[purpose]?.current).toBeUndefined();
    s.push('ondemand.stopped', {
      stageId: 'implement',
      purpose,
      attemptId: 'a2',
      reason: 'stage_ended',
    });
    expect(s.model.stages[2]?.ondemand?.[purpose]).toEqual({
      active: false,
      attemptId: 'a2',
      queue: ['second'],
    });
    s.push('seat.spawned', {
      ...payloads['seat.spawned'],
      attemptId: 'a3',
      purpose: 'integrator',
      ondemand: undefined,
    });
    expect(s.model.seats[0]?.currentAttemptId).toBe('a3');
    expect(s.model.seats[0]?.attempts.at(-1)?.ondemand).toBeUndefined();
    expect(s.model.seats[0]?.attempts[0]?.ondemand).toEqual({ purpose });
    expect(replay(s.events)).toEqual(s.model);
  },
);

test('review, rework and merge retain worker identity, PR, base and recorded rework count', () => {
  const s = scenario();
  s.push('workitem.approved');
  s.push('workitem.dispatched', {
    ...payloads['workitem.dispatched'],
    baseSha: 'aaaaaaa',
  });
  s.push('artifact.created');
  s.push('pr.status', { ...payloads['pr.status'], state: 'open' });
  s.push('workitem.merge_queued');
  expect(s.model.workItems[0]).toMatchObject({
    status: 'merge_queued',
    currentAttemptId: 'a6',
    headSha: 'abcdef1',
    baseSha: 'aaaaaaa',
    pr: { number: 5 },
  });
  s.push('ondemand.queue_changed', {
    stageId: 'implement',
    purpose: 'merge',
    queue: ['w1'],
  });
  s.push('workitem.status', { itemKey: 'w1', status: 'in_review' });
  s.push('ondemand.queue_changed', {
    stageId: 'implement',
    purpose: 'merge',
    queue: [],
    current: 'w1',
  });
  expect(s.model.workItems[0]?.status).toBe('in_review');
  expect(
    s.model.workItems.find(
      (w) => w.key === s.model.stages[2]?.ondemand?.merge?.current,
    )?.pr?.number,
  ).toBe(5);
  s.push('workitem.rework_requested', {
    ...payloads['workitem.rework_requested'],
    reasons: ['Add tests', 'Fix behavior'],
    rework: 2,
  });
  expect(s.model.workItems[0]).toMatchObject({
    status: 'rework',
    reworks: 2,
    reason: 'Add tests\nFix behavior',
    currentAttemptId: 'a6',
  });
  // A repeated request fact must use the recorded counter, not increment it.
  s.push('workitem.rework_requested', {
    ...payloads['workitem.rework_requested'],
    rework: 2,
  });
  s.push('workitem.dispatched', {
    ...payloads['workitem.dispatched'],
    attemptId: 'a8',
    attempt: 3,
    reworkOf: 'a6',
    baseSha: 'bbbbbbb',
  });
  expect(s.model.workItems[0]).toMatchObject({
    status: 'dispatched',
    attempts: 3,
    reworks: 2,
    currentAttemptId: 'a8',
    baseSha: 'bbbbbbb',
    branch: payloads['workitem.dispatched'].branch,
    pr: { number: 5 },
  });
  s.push('workitem.merge_queued', {
    ...payloads['workitem.merge_queued'],
    attemptId: 'a8',
    headSha: 'ccccccc',
  });
  s.push('workitem.merged');
  expect(s.model.workItems[0]).toMatchObject({
    status: 'merged',
    mergeCommitSha: 'abcdef2',
    reworks: 2,
    headSha: 'ccccccc',
  });
  s.push('pr.status');
  expect(s.model.workItems[0]?.status).toBe('merged');
  expect(WorkflowReadModelSchema.parse(s.model)).toEqual(s.model);
  expect(replay(s.events)).toEqual(s.model);
  const snapshot = WorkflowReadModelSchema.parse(
    JSON.parse(JSON.stringify(s.model)),
  );
  const next = event('workitem.dispatched', snapshot.lastSeq + 1);
  expect(evolve(snapshot, next).workItems[0]?.baseSha).toBeUndefined();
  expect(snapshot.workItems[0]?.baseSha).toBe('bbbbbbb');
});

test('version 1 checkpoints rebuild missing progressive-merge projections', () => {
  const s = scenario();
  s.push('workitem.approved');
  s.push('workitem.rework_requested');
  const old = structuredClone(s.model);
  old.workItems[0]!.reworks = 0;
  delete old.stages[2]!.ondemand!.merge;
  expect(PROJECTION_VERSION).toBeGreaterThan(1);
  expect(
    replay(s.events, Infinity, {
      projectionVersion: 1,
      asOfSeq: old.lastSeq,
      eventCount: s.events.length,
      readModel: old,
    }),
  ).toEqual(s.model);
});
