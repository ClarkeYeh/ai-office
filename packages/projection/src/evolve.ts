import { clone } from './model.js';
import type { DomainEvent } from '@ai-office/contracts/events';
import { startWorkflow, type ReadModel } from './model.js';
import { applyArtifacts } from './artifacts.js';
import { applyGates } from './gates.js';
import { applySeats } from './seats.js';
import { applyUsage, refreshBudgets } from './usage.js';
import { applyWorkflow } from './workflow.js';

/**
 * Pure total fold over schema-valid events. Missing entities are ignored, not invented.
 * null represents a workflow whose workflow.started has not been observed yet.
 * Input events must be in global seq order; repeats/older seqs are identity no-ops.
 */
export function evolve(model: ReadModel, event: DomainEvent): ReadModel;
export function evolve(
  model: ReadModel | null,
  event: DomainEvent,
): ReadModel | null;
export function evolve(
  model: ReadModel | null,
  event: DomainEvent,
): ReadModel | null {
  if (
    model &&
    (event.seq <= model.lastSeq || event.workflowId !== model.workflowId)
  )
    return model;
  if (!model) {
    if (event.type !== 'workflow.started' || !event.workflowId) return null;
    const initial = startWorkflow(clone(event));
    refreshBudgets(initial, event);
    return initial;
  }
  // Clone once: every helper mutates only this private copy, never the snapshot or event.
  const next = clone(model);
  const e = clone(event);
  next.lastSeq = e.seq;
  applyWorkflow(next, e);
  applySeats(next, e);
  applyArtifacts(next, e);
  applyGates(next, e);
  applyUsage(next, e);
  refreshBudgets(next, e);
  return next;
}
