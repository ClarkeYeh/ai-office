import type {
  DomainEvent,
  DomainEventDraft,
} from '@ai-office/contracts/events';
export type Unsubscribe = () => void;
export type CursorWrite = { source: string; scope: string; value: unknown };
export type EventQuery = {
  workflowId?: string | null;
  afterSeq?: number;
  limit?: number;
};
export interface EventStore {
  /** Atomic batch; duplicate external keys are skipped, including within this batch.
   * Notify after commit in seq order. A listener failure must not undo committed data.
   */
  append(
    drafts: DomainEventDraft[],
    opts?: { cursors?: CursorWrite[] },
  ): DomainEvent[];
  read(q: EventQuery): DomainEvent[];
  readCursor(source: string, scope: string): unknown | null;
  lastSeq(): number;
  subscribe(listener: (event: DomainEvent) => void): Unsubscribe;
}
export type ProjectionCheckpoint<T> = {
  readModel: T;
  asOfSeq: number;
  version: number;
};
/** The consumer supplies its read-model type; ports cannot import projection or API. */
export interface ProjectionStore<T = unknown> {
  load(workflowId: string): ProjectionCheckpoint<T> | null;
  save(workflowId: string, rm: T, asOfSeq: number, version: number): void;
}
export interface SeatTokenStore {
  /** Issue once per attempt; repeated issue throws conflict, including after revoke. */
  issue(attemptId: string): string;
  verify(token: string): string | null;
  revoke(attemptId: string): void;
}
export interface SessionStore {
  /** Random secrets returned once; only hashes persist. Bootstrap lifetime: 60 seconds. */
  issueBootstrapCode(): string;
  /** Atomically consume a live code and issue a 30-day session; invalid codes return null. */
  exchangeBootstrapCode(code: string): string | null;
  verify(session: string): boolean;
  revoke(session: string): void;
}
export type IdempotencyRecord = {
  requestHash: string;
  response: { status: number; body: unknown };
  expiresAt: string;
};
export interface IdempotencyStore {
  get(scope: string, key: string): IdempotencyRecord | null;
  /** First writer wins; same hash is a no-op, different hash throws conflict. */
  put(scope: string, key: string, record: IdempotencyRecord): void;
}
export interface SpecStore {
  /** Persist with mode 0600 before command.issued; never regenerate on retry. */
  write(attemptId: string, content: string): { path: string; sha256: string };
  verify(path: string, sha256: string): boolean;
  remove(path: string): void;
}
