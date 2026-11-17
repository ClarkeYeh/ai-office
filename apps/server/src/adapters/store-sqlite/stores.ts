import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Clock } from '../../ports/services.js';
import { PortError } from '../../ports/errors.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
  ProjectionCheckpoint,
  ProjectionStore,
  SeatTokenStore,
  SessionStore,
} from '../../ports/stores.js';
import { json } from './json.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const secret = (prefix: string) => prefix + randomBytes(32).toString('hex');

export class SqliteProjectionStore<T = unknown> implements ProjectionStore<T> {
  constructor(
    private db: Database.Database,
    private expectedVersion?: number,
  ) {}
  load(workflowId: string): ProjectionCheckpoint<T> | null {
    const row = this.db
      .prepare(
        'SELECT read_model_json, as_of_seq, version FROM projections WHERE workflow_id = ?',
      )
      .get(workflowId) as
      | { read_model_json: string; as_of_seq: number; version: number }
      | undefined;
    if (
      !row ||
      (this.expectedVersion !== undefined &&
        row.version !== this.expectedVersion)
    )
      return null;
    return {
      readModel: JSON.parse(row.read_model_json) as T,
      asOfSeq: row.as_of_seq,
      version: row.version,
    };
  }
  save(workflowId: string, rm: T, asOfSeq: number, version: number): void {
    this.db
      .prepare(
        'INSERT INTO projections (workflow_id, read_model_json, as_of_seq, version) VALUES (?, ?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET read_model_json = excluded.read_model_json, as_of_seq = excluded.as_of_seq, version = excluded.version',
      )
      .run(workflowId, json(rm), asOfSeq, version);
  }
}

export class SqliteSeatTokenStore implements SeatTokenStore {
  constructor(private db: Database.Database) {}
  issue(attemptId: string): string {
    return this.db
      .transaction(() => {
        if (
          this.db
            .prepare('SELECT 1 FROM seat_tokens WHERE attempt_id = ?')
            .get(attemptId)
        )
          throw new PortError(
            'conflict',
            'seat_token_already_issued',
            'Seat token already issued',
          );
        const token = secret('aio_seat_');
        this.db
          .prepare('INSERT INTO seat_tokens (attempt_id, hash) VALUES (?, ?)')
          .run(attemptId, hash(token));
        return token;
      })
      .immediate();
  }
  rotateUnissued(attemptId: string): string {
    return this.db
      .transaction(() => {
        const issued = this.db
          .prepare(
            `SELECT 1 FROM events
        WHERE json_extract(event_json, '$.type') = 'command.issued'
        AND json_extract(event_json, '$.payload.kind') = 'runtime.spawnAgent'
        AND json_extract(event_json, '$.attemptId') = ? LIMIT 1`,
          )
          .get(attemptId);
        if (issued)
          throw new PortError(
            'conflict',
            'seat_token_reissue',
            'Spawn already issued',
          );
        this.db
          .prepare('DELETE FROM seat_tokens WHERE attempt_id = ?')
          .run(attemptId);
        return this.issue(attemptId);
      })
      .immediate();
  }
  verify(token: string): string | null {
    const row = this.db
      .prepare(
        'SELECT attempt_id FROM seat_tokens WHERE hash = ? AND revoked = 0',
      )
      .get(hash(token)) as { attempt_id: string } | undefined;
    return row?.attempt_id ?? null;
  }
  revoke(attemptId: string): void {
    // Keep the tombstone: an attempt must never receive a second token.
    this.db
      .prepare('UPDATE seat_tokens SET revoked = 1 WHERE attempt_id = ?')
      .run(attemptId);
  }
}

export class SqliteSessionStore implements SessionStore {
  constructor(
    private db: Database.Database,
    private clock: Clock,
  ) {}
  issueBootstrapCode(): string {
    const code = secret('aio_bootstrap_');
    this.db
      .prepare('INSERT INTO bootstrap_codes (hash, expires_at) VALUES (?, ?)')
      .run(hash(code), this.clock.now().getTime() + 60_000);
    return code;
  }
  exchangeBootstrapCode(code: string): string | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            'DELETE FROM bootstrap_codes WHERE hash = ? RETURNING expires_at',
          )
          .get(hash(code)) as { expires_at: number } | undefined;
        if (!row || row.expires_at <= this.clock.now().getTime()) return null;
        const session = secret('aio_session_');
        this.db
          .prepare('INSERT INTO sessions (hash, expires_at) VALUES (?, ?)')
          .run(
            hash(session),
            this.clock.now().getTime() + 30 * 24 * 60 * 60 * 1000,
          );
        return session;
      })
      .immediate();
  }
  verify(session: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?')
      .get(hash(session), this.clock.now().getTime());
  }
  revoke(session: string): void {
    this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(session));
  }
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(
    private db: Database.Database,
    private clock: Clock,
  ) {}
  get(scope: string, key: string): IdempotencyRecord | null {
    const row = this.db
      .prepare(
        'SELECT request_hash, response_json, expires_at FROM idempotency_keys WHERE scope = ? AND key = ?',
      )
      .get(scope, key) as
      | { request_hash: string; response_json: string; expires_at: string }
      | undefined;
    if (!row || Date.parse(row.expires_at) <= this.clock.now().getTime())
      return null;
    return {
      requestHash: row.request_hash,
      response: JSON.parse(row.response_json) as IdempotencyRecord['response'],
      expiresAt: row.expires_at,
    };
  }
  put(scope: string, key: string, record: IdempotencyRecord): void {
    if (!Number.isFinite(Date.parse(record.expiresAt)))
      throw new RangeError('Invalid expiry');
    this.db
      .transaction(() => {
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
        this.db
          .prepare(
            'INSERT INTO idempotency_keys (scope, key, request_hash, response_json, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET request_hash = excluded.request_hash, response_json = excluded.response_json, expires_at = excluded.expires_at',
          )
          .run(
            scope,
            key,
            record.requestHash,
            json(record.response),
            record.expiresAt,
          );
      })
      .immediate();
  }
}
