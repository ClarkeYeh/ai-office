import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import type { DomainEvent, EventType } from '@ai-office/contracts/events';
import { evolve, type ReadModel } from '../index.js';
import { event, payloads } from './events.js';

export function scenario(start: unknown = payloads['workflow.started']) {
  const events: DomainEvent[] = [];
  let model: ReadModel | null = null;
  const push = (
    type: EventType,
    payload: unknown = payloads[type],
    extra: Partial<DomainEvent> = {},
  ) => {
    const e = {
      ...event(type, events.length + 1, payload),
      ...extra,
    } as DomainEvent;
    events.push(e);
    model = evolve(model, e);
    if (model) WorkflowReadModelSchema.parse(model);
    return model!;
  };
  push('workflow.started', start);
  return {
    push,
    events,
    get model() {
      return model!;
    },
  };
}
export function prepared() {
  const s = scenario();
  s.push('stage.started');
  s.push('stage.started', {
    stageId: 'integrate',
    kind: 'integrate',
    attempt: 2,
    mode: 'revision',
  });
  s.push('workitem.proposed');
  for (const [attemptId, role, itemKey] of [
    ['a1', 'lead', undefined],
    ['a4', 'engineer', 'w1'],
    ['a5', 'lead', undefined],
    ['a6', 'engineer', 'w1'],
  ] as const) {
    s.push('seat.spawned', {
      ...payloads['seat.spawned'],
      attemptId,
      seatId: `wf1:${role}${itemKey ? ':' + itemKey : ''}`,
      role,
      itemKey,
    });
  }
  s.push('message.question');
  s.push('submission.accepted', {
    ...payloads['submission.accepted'],
    artifactId: 'art1',
  });
  s.push('gate.opened');
  s.push('gate.opened', { ...payloads['gate.opened'], gateId: 'g3' });
  s.push('ondemand.started', {
    stageId: 'implement',
    purpose: 'oncall',
    attemptId: 'a5',
  });
  return s;
}
