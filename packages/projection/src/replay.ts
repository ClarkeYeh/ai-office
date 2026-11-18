import { clone } from './model.js';
import type { DomainEvent } from '@ai-office/contracts/events';
import { evolve } from './evolve.js';
import {
  CHECKPOINT_INTERVAL,
  PROJECTION_VERSION,
  type ReadModel,
} from './model.js';

export interface Checkpoint {
  projectionVersion: number;
  /** Number of applied events, not global seq (a workflow stream can have gaps). */
  eventCount: number;
  asOfSeq: number;
  readModel: ReadModel;
}

/** Replay a single workflow's ordered stream, inclusive of toSeq. */
export function replay(
  events: readonly DomainEvent[],
  toSeq = Infinity,
  checkpoint?: Checkpoint,
): ReadModel | null {
  let model =
    checkpoint &&
    checkpoint.projectionVersion === PROJECTION_VERSION &&
    checkpoint.asOfSeq <= toSeq
      ? clone(checkpoint.readModel)
      : null;
  for (const event of events)
    if (event.seq <= toSeq) model = evolve(model, event);
  return model;
}

/** Immutable snapshots every 500 newly applied workflow events; callers own storage. */
export function createCheckpoints(
  events: readonly DomainEvent[],
): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  let model: ReadModel | null = null;
  let eventCount = 0;
  for (const event of events) {
    const next: ReadModel | null = evolve(model, event);
    if (next === model) continue;
    model = next;
    if (!model) continue;
    eventCount += 1;
    if (eventCount % CHECKPOINT_INTERVAL === 0)
      checkpoints.push({
        projectionVersion: PROJECTION_VERSION,
        eventCount,
        asOfSeq: model.lastSeq,
        readModel: model,
      });
  }
  return checkpoints;
}

/** Select the latest compatible checkpoint at or before the requested position. */
export function replayWithCheckpoints(
  events: readonly DomainEvent[],
  toSeq: number,
  checkpoints: readonly Checkpoint[],
): ReadModel | null {
  let checkpoint: Checkpoint | undefined;
  for (const candidate of checkpoints)
    if (
      candidate.projectionVersion === PROJECTION_VERSION &&
      candidate.asOfSeq <= toSeq &&
      (!checkpoint || candidate.asOfSeq > checkpoint.asOfSeq)
    )
      checkpoint = candidate;
  return replay(events, toSeq, checkpoint);
}
