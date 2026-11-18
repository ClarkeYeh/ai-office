import { DomainEventSchema } from '@ai-office/contracts/events';
import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import { evolve } from '@ai-office/projection';

/** Semantic comparison tolerates independent observations crossing an HTTP decision. */
export function checkpoints(input: unknown[]) {
  const events = input.map((event) => DomainEventSchema.parse(event));
  let model: ReturnType<typeof evolve> = null;
  for (const event of events) model = evolve(model, event);
  if (!model) throw new Error('Recording has no workflow');
  WorkflowReadModelSchema.parse(model);
  const counts: Record<string, number> = {};
  const itemSequences: Record<string, string[]> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    if (event.type === 'workitem.status')
      (itemSequences[event.payload.itemKey] ??= []).push(event.payload.status);
  }
  return {
    counts,
    itemSequences,
    decisions: events
      .filter((e) => e.type === 'gate.decided')
      .map((e) => ({
        stageId: e.stageId,
        decision: e.payload.decision,
        optionId: e.payload.optionId,
      })),
    model: {
      status: model.status,
      currentStageId: model.currentStageId,
      pausedReasons: model.pausedReasons,
      stages: model.stages.map((s) => ({
        id: s.stageId,
        kind: s.kind,
        status: s.status,
      })),
      items: model.workItems
        .map((i) => ({
          key: i.key,
          status: i.status,
          attempts: i.attempts,
          reworks: i.reworks,
          deps: i.deps,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      gates: model.gates.map((g) => ({
        kind: g.kind,
        stageKind: g.stageKind,
        exceptionKind: g.exceptionKind,
        status: g.status,
        decision: g.decision?.decision,
      })),
      seats: model.seats
        .map((s) => ({
          role: s.role,
          itemKey: s.itemKey,
          attempts: s.attempts.map((a) => ({
            state: a.state,
            degraded: a.degraded,
          })),
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      questions: model.questions.map((q) => ({
        status: q.status,
        answer: q.answer?.by,
      })),
    },
  };
}
