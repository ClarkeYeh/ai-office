import {
  evolve,
  PROJECTION_VERSION,
  type ReadModel,
} from '@ai-office/projection';
import type { DomainEvent } from '@ai-office/contracts/events';
import type { Clock, ScheduledTimer, Scheduler } from '../../ports/services.js';
import type { EventStore, ProjectionStore } from '../../ports/stores.js';

type Entry = { readModel: ReadModel | null; asOfSeq: number; dirty: number };
export type WorkflowSnapshot = { readModel: ReadModel; asOfSeq: number };
const timerId = (id: string) => `projection-save:${id}`;

/** Wire a dedicated Scheduler's sink to onTimer; these are cache timers, not domain events. */
export class ProjectionService {
  private readonly entries = new Map<string, Entry>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly events: EventStore,
    private readonly checkpoints: ProjectionStore<ReadModel>,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
  ) {
    this.unsubscribe = events.subscribe((event) => {
      if (event.workflowId !== null) this.catchUp(event.workflowId);
    });
  }

  snapshot(workflowId: string): WorkflowSnapshot | null {
    if (this.closed) throw new Error('ProjectionService is closed');
    const entry = this.catchUp(workflowId);
    return entry.readModel
      ? structuredClone({ readModel: entry.readModel, asOfSeq: entry.asOfSeq })
      : null;
  }

  private catchUp(workflowId: string): Entry {
    let entry = this.entries.get(workflowId);
    if (!entry) {
      const saved = this.checkpoints.load(workflowId);
      entry =
        saved?.version === PROJECTION_VERSION
          ? { readModel: saved.readModel, asOfSeq: saved.asOfSeq, dirty: 0 }
          : { readModel: null, asOfSeq: 0, dirty: 0 };
      this.entries.set(workflowId, entry);
    }
    // Read the committed log, rather than trusting a notification to be the next event.
    // This also handles restart catch-up and reentrant post-commit notifications.
    for (;;) {
      const batch = this.events.read({
        workflowId,
        afterSeq: entry.asOfSeq,
        limit: 200,
      });
      for (const event of batch) this.apply(workflowId, entry, event);
      if (batch.length < 200) break;
    }
    return entry;
  }

  private apply(workflowId: string, entry: Entry, event: DomainEvent): void {
    entry.readModel = evolve(entry.readModel, event);
    entry.asOfSeq = event.seq;
    entry.dirty++;
    if (entry.dirty >= 200) this.save(workflowId, entry);
    if (entry.dirty > 0)
      this.scheduler.schedule({
        id: timerId(workflowId),
        workflowId,
        fireAt: new Date(this.clock.now().getTime() + 5_000).toISOString(),
      });
  }

  private save(workflowId: string, entry: Entry): void {
    if (!entry.readModel || entry.dirty === 0) return;
    try {
      this.checkpoints.save(
        workflowId,
        entry.readModel,
        entry.asOfSeq,
        PROJECTION_VERSION,
      );
      entry.dirty = 0;
      this.scheduler.cancel(timerId(workflowId));
    } catch {
      // Checkpoints are disposable caches. Keep dirty state for the next retry.
    }
  }

  onTimer(timer: ScheduledTimer): void {
    if (this.closed || timer.id !== timerId(timer.workflowId)) return;
    const entry = this.entries.get(timer.workflowId);
    if (entry) this.save(timer.workflowId, entry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const [id, entry] of this.entries) {
      this.save(id, entry);
      this.scheduler.cancel(timerId(id));
    }
  }
}
