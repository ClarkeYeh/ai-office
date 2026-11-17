import { expect, test } from 'vitest';
import fc from 'fast-check';
import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import {
  createCheckpoints,
  evolve,
  replay,
  replayWithCheckpoints,
  PROJECTION_VERSION,
} from './index.js';
import { event, payloads } from './test-support/events.js';
import { prepared } from './test-support/scenario.js';

test('snapshot serialization retains pending submissions for later gates and content updates', () => {
  const s = prepared();
  s.push('submission.accepted', {
    ...payloads['submission.accepted'],
    artifactId: 'new-conclusion',
  });
  s.push('submission.accepted', {
    submissionId: 'plan-sub',
    attemptId: 'a1',
    kind: 'work-items',
    artifactId: 'plan-art',
    submission: {
      kind: 'work-items',
      payload: { items: payloads['workitem.proposed'].items },
    },
  });
  let snapshot = WorkflowReadModelSchema.parse(
    JSON.parse(JSON.stringify(s.model)),
  );
  for (const e of [
    event('gate.content_updated', 100, {
      gateId: 'g1',
      source: 'agent',
      version: 2,
      artifactId: 'new-conclusion',
    }),
    event('gate.opened', 101, {
      ...payloads['gate.opened'],
      gateId: 'plan',
      stageId: 'planning',
      stageKind: 'planning',
      content: { type: 'work-items', artifactId: 'plan-art' },
    }),
  ]) {
    snapshot = evolve(snapshot, e);
    s.events.push(e);
  }
  expect(snapshot).toEqual(replay(s.events));
  expect(snapshot.gates[0]?.conclusion?.original?.summary).toBe('Build it');
  expect(snapshot.gates.at(-1)?.workItems).toHaveLength(1);
});

test('checkpoints count applied events with seq gaps, excluding duplicates and foreign events', () => {
  const events = [
    event('workflow.started', 1),
    ...Array.from({ length: 1004 }, (_, i) =>
      event('workflow.paused', (i + 1) * 3),
    ),
  ];
  events.splice(
    8,
    0,
    event('workflow.cancelled', 20, undefined, 'foreign'),
    event('workflow.cancelled', 1),
  );
  const checkpoints = createCheckpoints(events);
  expect(checkpoints.map((c) => c.eventCount)).toEqual([500, 1000]);
  expect(checkpoints.map((c) => c.asOfSeq)).toEqual([1497, 2997]);
  expect(checkpoints[0]?.readModel.lastSeq).toBe(1497);
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 3015 }), (toSeq) => {
      expect(replayWithCheckpoints(events, toSeq, checkpoints)).toEqual(
        replay(events, toSeq),
      );
    }),
    { numRuns: 30, seed: 7007 },
  );
  const checkpoint = checkpoints[0]!;
  expect(
    replay(events, Infinity, {
      ...checkpoint,
      projectionVersion: PROJECTION_VERSION + 1,
    }),
  ).toEqual(replay(events));
  expect(replay(events, 10, checkpoint)).toEqual(replay(events, 10));
  expect(
    replayWithCheckpoints(events, 3015, [...checkpoints].reverse()),
  ).toEqual(replay(events));
  expect(createCheckpoints([event('seat.spawned')])).toEqual([]);
  expect(replay([], 0)).toBeNull();
});
