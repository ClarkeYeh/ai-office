import type { DomainEvent } from '@ai-office/contracts/events';
import {
  CHECKPOINT_INTERVAL,
  PROJECTION_VERSION,
  evolve,
  replayWithCheckpoints,
  type Checkpoint,
  type ReadModel,
} from '@ai-office/projection';

/** Main thread → replay worker. */
export type ReplayRequest =
  | { type: 'append'; events: DomainEvent[] }
  | { type: 'seek'; id: number; seq: number };

/** Replay worker → main thread. Only results cross the boundary, never checkpoints. */
export type ReplayResponse =
  | { type: 'appended'; eventCount: number; lastSeq: number }
  | { type: 'result'; id: number; seq: number; model: ReadModel | null };

/**
 * Incremental `createCheckpoints`: appending a page extends the checkpoints instead of
 * rebuilding them, with the same positions as `createCheckpoints(events)`.
 */
export function createReplayEngine() {
  const events: DomainEvent[] = [];
  const checkpoints: Checkpoint[] = [];
  let model: ReadModel | null = null;
  let applied = 0;
  return {
    append(batch: readonly DomainEvent[]) {
      for (const event of batch) {
        if (events.length && event.seq <= events[events.length - 1]!.seq)
          continue;
        events.push(event);
        const next: ReadModel | null = evolve(model, event);
        if (!next || next === model) continue;
        model = next;
        applied++;
        if (applied % CHECKPOINT_INTERVAL === 0)
          checkpoints.push({
            projectionVersion: PROJECTION_VERSION,
            eventCount: applied,
            asOfSeq: model.lastSeq,
            readModel: model,
          });
      }
    },
    query: (seq: number) => replayWithCheckpoints(events, seq, checkpoints),
    get eventCount() {
      return events.length;
    },
    get lastSeq() {
      return events.length ? events[events.length - 1]!.seq : 0;
    },
    get checkpoints(): readonly Checkpoint[] {
      return checkpoints;
    },
  };
}

export interface WorkerScope {
  onmessage: ((message: MessageEvent<ReplayRequest>) => void) | null;
  postMessage(message: ReplayResponse): void;
}

/**
 * Seeks are coalesced: a drag queues many requests, and only the newest one still
 * pending when the worker gets to it is computed and answered.
 */
export function attachReplayEngine(scope: WorkerScope): void {
  const engine = createReplayEngine();
  let pending: { id: number; seq: number } | null = null;
  let scheduled = false;
  function answer() {
    scheduled = false;
    const request = pending!;
    pending = null;
    scope.postMessage({
      type: 'result',
      id: request.id,
      seq: request.seq,
      model: engine.query(request.seq),
    });
  }
  scope.onmessage = ({ data }) => {
    if (data.type === 'append') {
      engine.append(data.events);
      scope.postMessage({
        type: 'appended',
        eventCount: engine.eventCount,
        lastSeq: engine.lastSeq,
      });
      return;
    }
    pending = { id: data.id, seq: data.seq };
    if (!scheduled) {
      scheduled = true;
      setTimeout(answer, 0);
    }
  };
}
