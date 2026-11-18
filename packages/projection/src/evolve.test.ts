import { expect, test } from 'vitest';
import fc from 'fast-check';
import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import { EVENT_TYPES, type EventType } from '@ai-office/contracts/events';
import { evolve, initialReadModel, replay } from './index.js';
import { clone } from './model.js';
import { event, payloads, at } from './test-support/events.js';
import { prepared, scenario } from './test-support/scenario.js';

test('empty, foreign, duplicate and older events are identity no-ops', () => {
  expect(initialReadModel()).toBeNull();
  expect(evolve(null, event('seat.spawned'))).toBeNull();
  expect(
    evolve(null, event('workflow.started', 1, undefined, null)),
  ).toBeNull();
  const m = scenario().model;
  expect(evolve(m, event('workflow.cancelled', 2, undefined, 'other'))).toBe(m);
  expect(evolve(m, event('workflow.cancelled', 1))).toBe(m);
  const newer = evolve(m, event('workflow.paused', 3));
  expect(evolve(newer, event('workflow.cancelled', 2))).toBe(newer);
});

// Every catalog event has an explicit read-side behavior (or documented intent-only no-op).
const assertions: Partial<
  Record<EventType, (m: ReturnType<typeof prepared>['model']) => void>
> = {
  'workflow.started': (m) => expect(m.status).toBe('running'),
  'workflow.paused': (m) =>
    expect(m.pausedReasons).toContain('runtime_unhealthy'),
  'workflow.resumed': (m) => expect(m.pausedReasons).not.toContain('anomaly'),
  'workflow.completed': (m) => expect(m.outcome?.finalPr).toBe(9),
  'workflow.failed': (m) =>
    expect(m.outcome?.failReason).toBe('max_reruns_exceeded'),
  'workflow.cancel_requested': (m) => expect(m.cancelRequested).toBe(true),
  'workflow.cancelled': (m) => expect(m.status).toBe('cancelled'),
  'stage.started': (m) => expect(m.stages[0]?.runs).toHaveLength(1),
  'stage.completed': (m) => expect(m.stages[0]?.status).toBe('done'),
  'stage.failed': (m) => expect(m.stages[3]?.status).toBe('failed'),
  'gate.opened': (m) =>
    expect(m.gates[0]?.conclusion?.original?.summary).toBe('Build it'),
  'gate.content_updated': (m) => expect(m.gates[0]?.version).toBe(2),
  'gate.decided': (m) => expect(m.gates[0]?.status).toBe('approved'),
  'gate.closed': (m) => expect(m.gates[1]?.closeReason).toBe('merged'),
  'seat.spawned': (m) => expect(m.seats[0]?.attempts).toHaveLength(2),
  'seat.status': (m) =>
    expect(m.seats[0]?.attempts[0]?.state).toBe('waiting_input'),
  'seat.activity': (m) =>
    expect(m.seats[0]?.recentActivity[0]?.tool).toBe('Bash'),
  'seat.degraded': (m) =>
    expect(m.seats[0]?.attempts[0]?.degradedReason).toBe('source_changed'),
  'seat.policy_violation': (m) =>
    expect(m.seats[0]?.policyHits[0]?.rule).toBe('gh-merge'),
  'seat.exited': (m) => expect(m.seats[0]?.attempts[0]?.endedAt).toBe(at),
  'seat.released': (m) => expect(m.seats[0]?.attempts[0]?.released).toBe(true),
  'meeting.round_started': (m) => expect(m.stages[0]?.meeting?.round).toBe(1),
  'meeting.statement': (m) =>
    expect(m.stages[0]?.meeting?.statements[0]?.position).toBe('Agree'),
  'meeting.round_completed': (m) => expect(m.stages[0]?.meeting?.round).toBe(1),
  'meeting.concluded': (m) =>
    expect(m.stages[0]?.meeting?.concluded).toBe(true),
  'submission.accepted': (m) =>
    expect(m.acceptedSubmissions.art3?.kind).toBe('conclusion'),
  'message.question': (m) =>
    expect(m.questions[0]?.body).toContain('Which DB?'),
  'message.forwarded': (m) =>
    expect(m.questions[0]?.forwardedTo).toBe('on-call'),
  'message.answered': (m) =>
    expect(m.questions[0]?.answer?.body).toBe('sqlite'),
  'message.escalated': (m) =>
    expect(m.questions[0]?.escalation?.reason).toBe('timeout'),
  'ondemand.started': (m) =>
    expect(m.stages[2]?.ondemand?.oncall?.active).toBe(true),
  'ondemand.queue_changed': (m) =>
    expect(m.stages[2]?.ondemand?.oncall?.queue).toEqual(['msg1', 'msg2']),
  'ondemand.stopped': (m) =>
    expect(m.stages[2]?.ondemand?.oncall?.active).toBe(false),
  'workitem.proposed': (m) => expect(m.workItems[0]?.status).toBe('proposed'),
  'workitem.approved': (m) => expect(m.workItems[0]?.agent).toBe('codex'),
  'workitem.dispatched': (m) =>
    expect(m.workItems[0]?.workspaceName).toBe('aio-abcd1234-w1-a2'),
  'workitem.status': (m) => expect(m.workItems[0]?.status).toBe('pr_open'),
  'workitem.merge_queued': (m) =>
    expect(m.workItems[0]).toMatchObject({
      status: 'merge_queued',
      headSha: 'abcdef1',
    }),
  'workitem.rework_requested': (m) =>
    expect(m.workItems[0]).toMatchObject({
      status: 'rework',
      reworks: 1,
      reason: 'missing tests',
    }),
  'workitem.merged': (m) =>
    expect(m.workItems[0]).toMatchObject({
      status: 'merged',
      mergeCommitSha: 'abcdef2',
    }),
  'artifact.created': (m) => expect(m.artifacts[0]?.number).toBe(5),
  'pr.status': (m) => expect(m.prs[0]?.state).toBe('merged'),
  'scm.issue_drift': (m) =>
    expect(m.gates[0]?.conclusion?.githubBodyHash).toBe('b'.repeat(64)),
  'anomaly.detected': (m) =>
    expect(m.anomalies[0]?.kind).toBe('unknown-object'),
  'usage.tokens': (m) => expect(m.usage.total.budgetTokens).toBe(35),
  'usage.turns': (m) => expect(m.usage.total.turns).toBe(1),
  'budget.exceeded': (m) =>
    expect(
      m.budgetBars.some((b) => b.scope === 'item' && b.level === 'exceeded'),
    ).toBe(true),
  'budget.hard_limit': (m) =>
    expect(
      m.budgetBars.some((b) => b.scope === 'stage' && b.level === 'hard_limit'),
    ).toBe(true),
  'command.failed': (m) => expect(m.errors[0]?.code).toBe('github_5xx'),
  'error.recorded': (m) =>
    expect(m.errors[0]?.code).toBe('merge_default_branch'),
};
const noViewChange: EventType[] = [
  'stage.rerun_requested',
  'agent.unmanaged',
  'submission.rejected',
  'message.nudge',
  'message.instruction',
  'command.issued',
  'command.succeeded',
  'command.reconciled',
  'timer.scheduled',
  'timer.fired',
  'timer.cancelled',
  'repo.registered',
  'repo.updated',
  'health.changed',
  'runtime.identity_restored',
  'runtime.identity_hijacked',
];
test('behavior catalog covers every event type', () =>
  expect([...Object.keys(assertions), ...noViewChange].sort()).toEqual(
    [...EVENT_TYPES].sort(),
  ));
test.each(EVENT_TYPES)(
  '%s projects its documented behavior and validates',
  (type) => {
    const s = prepared();
    if (type === 'pr.status') s.push('artifact.created');
    const before = clone(s.model);
    const payload =
      type === 'scm.issue_drift'
        ? { ...payloads[type], gateId: 'g1' }
        : payloads[type];
    const m = s.push(type, payload);
    if (noViewChange.includes(type))
      expect(m).toEqual({ ...before, lastSeq: m.lastSeq });
    else assertions[type]!(m);
    expect(WorkflowReadModelSchema.safeParse(m).success).toBe(true);
  },
);

test('arbitrary event sequences are total, schema-valid, immutable and batch-independent', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...EVENT_TYPES), { maxLength: 90 }),
      fc.nat(),
      (types, split) => {
        const events = [
          event('workflow.started'),
          ...types.map((type, i) => event(type, i + 2)),
        ];
        const original = clone(events);
        let model = initialReadModel();
        for (const e of events) {
          const before = clone(model);
          const next = evolve(model, e);
          expect(model).toEqual(before);
          if (next) WorkflowReadModelSchema.parse(next);
          model = next;
        }
        const cut = split % (events.length + 1);
        let batched = replay(events.slice(0, cut));
        if (batched)
          batched = WorkflowReadModelSchema.parse(
            JSON.parse(JSON.stringify(batched)),
          );
        for (const e of events.slice(cut)) batched = evolve(batched, e);
        expect(batched).toEqual(model);
        expect(events).toEqual(original);
      },
    ),
    { numRuns: 150, seed: 71937 },
  );
});
