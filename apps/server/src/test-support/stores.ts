import { createHash, randomBytes } from 'node:crypto';
import { DomainEventSchema } from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
} from '@ai-office/contracts/events';
import type { Clock, IdGen } from '../ports/services.js';
import type {
  CursorWrite,
  EventQuery,
  EventStore,
  ProjectionStore,
  ProjectionCheckpoint,
  SeatTokenStore,
  SessionStore,
  IdempotencyStore,
  IdempotencyRecord,
} from '../ports/stores.js';
import { PortError } from '../ports/errors.js';
import { FakeClock, SeqIdGen } from './services.js';
const copy = <T>(value: T): T => structuredClone(value);
export class InMemoryEventStore implements EventStore {
  private events: DomainEvent[] = [];
  private cursors = new Map<string, unknown>();
  private keys = new Set<string>();
  private listeners = new Set<(event: DomainEvent) => void>();
  private pending: DomainEvent[] = [];
  private notifying = false;
  constructor(
    private clock: Clock = new FakeClock(),
    private ids: IdGen = new SeqIdGen(),
  ) {}
  append(
    drafts: DomainEventDraft[],
    opts?: { cursors?: CursorWrite[] },
  ): DomainEvent[] {
    const keys = new Set(this.keys);
    const batch: DomainEvent[] = [];
    for (const draft of drafts) {
      if (draft.externalKey !== undefined && keys.has(draft.externalKey))
        continue;
      const event = DomainEventSchema.parse({
        ...copy(draft),
        seq: this.events.length + batch.length + 1,
        id: this.ids.ulid(),
        recordedAt: this.clock.now().toISOString(),
      });
      batch.push(event);
      if (event.externalKey !== undefined) keys.add(event.externalKey);
    }
    const cursors = new Map(this.cursors);
    for (const cursor of opts?.cursors ?? [])
      cursors.set(
        JSON.stringify([cursor.source, cursor.scope]),
        copy(cursor.value),
      );
    // All validation and copying completes before publishing either half of the transaction.
    this.events.push(...batch);
    this.keys = keys;
    this.cursors = cursors;
    this.pending.push(...batch);
    if (!this.notifying) {
      this.notifying = true;
      try {
        while (this.pending.length) {
          const event = this.pending.shift()!;
          for (const listener of [...this.listeners]) {
            try {
              listener(copy(event));
            } catch {
              /* Committed data must not look like a failed append. */
            }
          }
        }
      } finally {
        this.notifying = false;
      }
    }
    return copy(batch);
  }
  read(q: EventQuery): DomainEvent[] {
    if (
      q.afterSeq !== undefined &&
      (!Number.isSafeInteger(q.afterSeq) || q.afterSeq < 0)
    )
      throw new RangeError('Invalid afterSeq');
    if (
      q.limit !== undefined &&
      (!Number.isSafeInteger(q.limit) || q.limit < 0)
    )
      throw new RangeError('Invalid limit');
    return copy(
      this.events
        .filter(
          (e) =>
            (q.workflowId === undefined || e.workflowId === q.workflowId) &&
            e.seq > (q.afterSeq ?? 0),
        )
        .slice(0, q.limit),
    );
  }
  readCursor(source: string, scope: string): unknown | null {
    return copy(this.cursors.get(JSON.stringify([source, scope])) ?? null);
  }
  lastSeq(): number {
    return this.events.length;
  }
  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
export class InMemoryProjectionStore<
  T = unknown,
> implements ProjectionStore<T> {
  private checkpoints = new Map<string, ProjectionCheckpoint<T>>();
  load(workflowId: string): ProjectionCheckpoint<T> | null {
    return copy(this.checkpoints.get(workflowId) ?? null);
  }
  save(
    workflowId: string,
    readModel: T,
    asOfSeq: number,
    version: number,
  ): void {
    this.checkpoints.set(workflowId, copy({ readModel, asOfSeq, version }));
  }
}
const hash = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');
const secret = (prefix: string) => prefix + randomBytes(32).toString('hex');
export class InMemorySeatTokenStore implements SeatTokenStore {
  constructor(private readonly events?: EventStore) {}
  private issued = new Set<string>();
  private hashes = new Map<string, string>();
  issue(attemptId: string): string {
    if (this.issued.has(attemptId))
      throw new PortError(
        'conflict',
        'seat_token_already_issued',
        'Seat token already issued',
      );
    const token = secret('aio_seat_');
    this.issued.add(attemptId);
    this.hashes.set(hash(token), attemptId);
    return token;
  }
  rotateUnissued(attemptId: string): string {
    if (
      this.events === undefined ||
      this.events
        .read({})
        .some(
          (e) =>
            e.type === 'command.issued' &&
            e.payload.kind === 'runtime.spawnAgent' &&
            e.attemptId === attemptId,
        )
    )
      throw new PortError(
        'conflict',
        'seat_token_reissue',
        'Cannot prove spawn unissued',
      );
    this.revoke(attemptId);
    this.issued.delete(attemptId);
    return this.issue(attemptId);
  }
  verify(token: string): string | null {
    return this.hashes.get(hash(token)) ?? null;
  }
  revoke(attemptId: string): void {
    for (const [key, value] of this.hashes)
      if (value === attemptId) this.hashes.delete(key);
  }
  /** Hash-only snapshot lets shared contract tests inspect persistence without raw secrets. */
  snapshot(): { hash: string; attemptId: string }[] {
    return [...this.hashes].map(([hash, attemptId]) => ({ hash, attemptId }));
  }
}
export class InMemorySessionStore implements SessionStore {
  private codes = new Map<string, number>();
  private sessions = new Map<string, number>();
  constructor(private clock: Clock = new FakeClock()) {}
  issueBootstrapCode(): string {
    const code = secret('aio_bootstrap_');
    this.codes.set(hash(code), this.clock.now().getTime() + 60_000);
    return code;
  }
  exchangeBootstrapCode(code: string): string | null {
    const key = hash(code),
      expiry = this.codes.get(key);
    this.codes.delete(key);
    if (expiry === undefined || expiry <= this.clock.now().getTime())
      return null;
    const session = secret('aio_session_');
    this.sessions.set(
      hash(session),
      this.clock.now().getTime() + 30 * 24 * 60 * 60 * 1000,
    );
    return session;
  }
  verify(session: string): boolean {
    const key = hash(session),
      expiry = this.sessions.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.clock.now().getTime()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }
  revoke(session: string): void {
    this.sessions.delete(hash(session));
  }
  snapshot(): { codes: [string, number][]; sessions: [string, number][] } {
    return { codes: [...this.codes], sessions: [...this.sessions] };
  }
}
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();
  constructor(private clock: Clock = new FakeClock()) {}
  get(scope: string, key: string): IdempotencyRecord | null {
    const id = JSON.stringify([scope, key]),
      record = this.records.get(id);
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= this.clock.now().getTime()) {
      this.records.delete(id);
      return null;
    }
    return copy(record);
  }
  put(scope: string, key: string, record: IdempotencyRecord): void {
    if (!Number.isFinite(Date.parse(record.expiresAt)))
      throw new RangeError('Invalid expiry');
    const prior = this.get(scope, key);
    if (prior) {
      if (prior.requestHash !== record.requestHash)
        throw new PortError(
          'conflict',
          'idempotency_mismatch',
          'Key reused for a different request',
        );
      return;
    }
    this.records.set(JSON.stringify([scope, key]), copy(record));
  }
}
