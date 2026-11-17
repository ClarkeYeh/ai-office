import { decide, evolve, initialState } from '@ai-office/domain';
import type { DomainCommand } from '@ai-office/domain';
import {
  CURRENT_SCHEMA_VERSION,
  DomainEventSchema,
} from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
  EventPayload,
  EventType,
} from '@ai-office/contracts/events';
import { startWorkflow, START } from '../../runner/test-support/harness.js';
export const meta = () => ({ occurredAt: START, source: 'agent' as const });
export const eventDraft = <T extends EventType>(
  type: T,
  payload: EventPayload<T>,
): DomainEventDraft =>
  ({
    type,
    payload,
    workflowId: 'wf-1',
    occurredAt: START,
    source: 'engine',
    provenance: 'decided',
    schemaVersion: CURRENT_SCHEMA_VERSION[type],
  }) as DomainEventDraft;
export class Harness {
  state = initialState();
  events: DomainEvent[] = [];
  given(...steps: (DomainCommand | DomainEventDraft)[]): this {
    for (const step of steps) {
      const result =
        'payload' in step
          ? { ok: true as const, events: [step] }
          : decide(this.state, step);
      if (!result.ok) throw new Error(result.error.code);
      for (const draft of result.events) {
        const seq = this.events.length + 1;
        const event = DomainEventSchema.parse({
          ...draft,
          seq,
          id: String(seq).padStart(26, '0'),
          recordedAt: START,
        });
        this.events.push(event);
        this.state = evolve(this.state, event);
      }
    }
    return this;
  }
}
export const startCommand = startWorkflow;
export const startStage = (stageId: string): DomainCommand => ({
  type: 'StartStage',
  meta: meta(),
  stageId,
});
export const spawn = (
  attemptId: string,
  role: string,
  stageId: string,
  extra: Partial<Extract<DomainCommand, { type: 'SpawnAttempt' }>>,
): DomainCommand => ({
  type: 'SpawnAttempt',
  meta: meta(),
  stageId,
  role,
  attemptId,
  purpose: 'participant',
  keepOpen: true,
  spawnCommandId: `spawn-${attemptId}`,
  ...extra,
});
export const rework = (submissionId: string): DomainCommand => ({
  type: 'RequestWorkItemRework',
  meta: meta(),
  submissionId,
  gateId: 'rework-limit',
});
export const reviewing = () => {
  const h = new Harness().given(startCommand());
  for (const [stageId, gateId, stageKind] of [
    ['meeting', 'conclusion', 'meeting'],
    ['breakdown', 'task-split', 'planning'],
  ] as const)
    h.given(
      startStage(stageId),
      { type: 'CompleteStage', meta: meta(), stageId, attempt: 1 },
      eventDraft('gate.opened', {
        kind: 'stage',
        gateId,
        stageId,
        templateGateId: gateId,
        stageKind,
        optional: true,
        title: gateId,
        options: [],
        content: { type: 'work-items', artifactId: 'artifact' },
        version: 1,
      }),
      eventDraft('gate.decided', {
        gateId,
        decision: 'approve',
        by: 'user',
        version: 1,
      }),
    );
  h.given(
    eventDraft('workitem.approved', {
      gateId: 'split',
      items: [
        {
          key: 'A',
          deps: [],
          title: 'Item',
          body: 'Build',
          acceptance: ['Works'],
          role: 'engineer',
          agent: 'codex',
        },
      ],
    }),
    startStage('implement'),
    {
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'A',
      attemptId: 'worker',
      baseSha: 'abcdef1',
    },
  );
  for (const status of ['in_progress', 'pushed', 'pr_open'] as const)
    h.given({
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: { itemKey: 'A', status },
    });
  return h.given(
    {
      type: 'QueueWorkItemForMerge',
      meta: meta(),
      item: { itemKey: 'A', attemptId: 'worker', pr: 11, headSha: 'abcdef2' },
    },
    {
      type: 'UpdateOnDemandQueue',
      meta: meta(),
      update: { stageId: 'implement', purpose: 'merge', queue: ['A'] },
    },
    spawn('merge', 'integrator', 'implement', { purpose: 'integrator' }),
    {
      type: 'StartOnDemand',
      meta: meta(),
      instance: { stageId: 'implement', purpose: 'merge', attemptId: 'merge' },
    },
    {
      type: 'UpdateOnDemandQueue',
      meta: meta(),
      update: {
        stageId: 'implement',
        purpose: 'merge',
        queue: [],
        current: 'A',
      },
    },
  );
};
