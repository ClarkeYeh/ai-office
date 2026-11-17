import type Database from 'better-sqlite3';
import { DomainEventSchema } from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
} from '@ai-office/contracts/events';
import type { Clock, IdGen } from '../../ports/services.js';
import type {
  CursorWrite,
  EventQuery,
  EventStore,
} from '../../ports/stores.js';
import { upcastEvent, type Upcasters } from './upcasters/index.js';
import { json } from './json.js';

export class SqliteEventStore implements EventStore {
  private listeners = new Set<(event: DomainEvent) => void>();
  private pending: DomainEvent[] = [];
  private notifying = false;
  constructor(
    private db: Database.Database,
    private clock: Clock,
    private ids: Pick<IdGen, 'ulid'>,
    private upcasters: Upcasters = {},
  ) {}
  append(
    drafts: DomainEventDraft[],
    opts?: { cursors?: CursorWrite[] },
  ): DomainEvent[] {
    const batch = this.db
      .transaction(() => {
        const inserted: DomainEvent[] = [];
        let seq = this.lastSeq();
        for (const draft of drafts) {
          if (
            draft.externalKey !== undefined &&
            this.db
              .prepare('SELECT 1 FROM events WHERE external_key = ?')
              .get(draft.externalKey)
          )
            continue;
          const event = DomainEventSchema.parse({
            ...draft,
            seq: ++seq,
            id: this.ids.ulid(),
            recordedAt: this.clock.now().toISOString(),
          });
          // New events and live notifications must already use the current version.
          if (
            event.schemaVersion !==
            (this.upcasters[event.type]?.currentVersion ?? 1)
          )
            throw new Error('New events must use the current schema version');
          this.db
            .prepare(
              'INSERT INTO events (seq, id, workflow_id, external_key, event_json) VALUES (?, ?, ?, ?, ?)',
            )
            .run(
              event.seq,
              event.id,
              event.workflowId,
              event.externalKey ?? null,
              json(event),
            );
          inserted.push(event);
        }
        for (const cursor of opts?.cursors ?? []) {
          this.db
            .prepare(
              'INSERT INTO ingest_cursors (source, scope, value_json) VALUES (?, ?, ?) ON CONFLICT(source, scope) DO UPDATE SET value_json = excluded.value_json',
            )
            .run(cursor.source, cursor.scope, json(cursor.value));
        }
        return inserted;
      })
      .immediate();
    this.pending.push(...batch);
    if (!this.notifying) {
      this.notifying = true;
      try {
        while (this.pending.length) {
          const event = this.pending.shift()!;
          for (const listener of [...this.listeners]) {
            try {
              listener(structuredClone(event));
            } catch {
              /* Commit already succeeded; isolate consumers. */
            }
          }
        }
      } finally {
        this.notifying = false;
      }
    }
    return structuredClone(batch);
  }
  read(q: EventQuery): DomainEvent[] {
    if (
      q.afterSeq !== undefined &&
      (!Number.isSafeInteger(q.afterSeq) || q.afterSeq < 0)
    )
      throw new RangeError('Invalid event offset');
    if (
      q.limit !== undefined &&
      (!Number.isSafeInteger(q.limit) || q.limit < 0)
    )
      throw new RangeError('Invalid event limit');
    const rows =
      q.workflowId === undefined
        ? this.db
            .prepare(
              'SELECT event_json FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
            )
            .all(q.afterSeq ?? 0, q.limit ?? -1)
        : this.db
            .prepare(
              'SELECT event_json FROM events WHERE seq > ? AND workflow_id IS ? ORDER BY seq LIMIT ?',
            )
            .all(q.afterSeq ?? 0, q.workflowId, q.limit ?? -1);
    return (rows as { event_json: string }[]).map((row) =>
      upcastEvent(JSON.parse(row.event_json), this.upcasters),
    );
  }
  readCursor(source: string, scope: string): unknown | null {
    const row = this.db
      .prepare(
        'SELECT value_json FROM ingest_cursors WHERE source = ? AND scope = ?',
      )
      .get(source, scope) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as unknown) : null;
  }
  lastSeq(): number {
    return (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
        .get() as { seq: number }
    ).seq;
  }
  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
