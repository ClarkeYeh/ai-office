import type { WorkflowReadModel } from '@ai-office/contracts/api';
import type { ShellStageGate } from './Shell.js';

/**
 * The template gate of a stage as a stage-strip chip (V3 design): pending
 * until it opens, open while it waits for you, done once decided. Gates turned
 * off at start are not shown; a rejected gate is pending again (its stage reruns).
 */
export function stageGateOf(
  model: WorkflowReadModel,
  stageId: string,
): ShellStageGate | undefined {
  const stage = model.template.stages.find((s) => s.id === stageId);
  if (!stage || !('gate' in stage)) return undefined;
  const { id, title } = stage.gate;
  if (model.gateToggles[id] === false) return undefined;
  const latest = model.gates
    .filter((g) => g.stageId === stageId && g.templateGateId === id)
    .at(-1);
  if (latest?.status === 'open')
    return {
      id,
      title,
      state: 'open',
      gateId: latest.gateId,
      href: `/gates/${encodeURIComponent(latest.gateId)}`,
    };
  return {
    id,
    title,
    state: latest && latest.status !== 'rejected' ? 'done' : 'pending',
  };
}
