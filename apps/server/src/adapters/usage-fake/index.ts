import { PortError } from '../../ports/errors.js';
import { UsageCursorSchema } from '../../ports/refs.js';
import type { UsageCursor } from '../../ports/refs.js';
import type { Clock } from '../../ports/services.js';
import type {
  UsageLocateRef,
  UsagePort,
  UsageRef,
  UsageSample,
} from '../../ports/usage.js';

export type FakeUsageTokens = Pick<
  UsageSample,
  'inputUncached' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'
>;
type Session = {
  locate: UsageLocateRef;
  ref: UsageRef;
  samples: UsageSample[];
};
export class FakeUsage implements UsagePort {
  private sessions = new Map<string, Session>();
  private source: 'session-log' | 'none';
  constructor(
    private options: { source?: 'session-log' | 'none'; clock?: Clock } = {},
  ) {
    this.source = options.source ?? 'session-log';
  }
  snapshot() {
    return structuredClone({
      version: 1 as const,
      source: this.source,
      sessions: [...this.sessions],
    });
  }
  restore(state: ReturnType<FakeUsage['snapshot']>): void {
    if (state.version !== 1)
      throw new Error('Unsupported fake usage snapshot version');
    const data = structuredClone(state);
    this.source = data.source;
    this.sessions = new Map(data.sessions);
  }
  setSource(source: 'session-log' | 'none') {
    this.source = source;
  }
  capabilities(): ReturnType<UsagePort['capabilities']> {
    return {
      source: this.source,
      agents: this.source === 'none' ? [] : ['claude-code', 'codex'],
      formatVerified: this.source !== 'none',
    };
  }
  registerAttempt(locate: UsageLocateRef): UsageRef {
    if (this.sessions.has(locate.attemptId))
      throw new PortError(
        'conflict',
        'attempt_exists',
        'Attempt already registered',
      );
    const sessionId = locate.reportedSessionId ?? `fake-${locate.attemptId}`;
    const ref = {
      attemptId: locate.attemptId,
      agent: locate.agent,
      sessionId,
      file: `fake://${encodeURIComponent(locate.attemptId)}`,
    };
    this.sessions.set(locate.attemptId, {
      locate: structuredClone(locate),
      ref,
      samples: [],
    });
    return structuredClone(ref);
  }
  async locate(query: UsageLocateRef) {
    if (this.source === 'none') return null;
    const session = this.sessions.get(query.attemptId);
    if (!session || session.ref.agent !== query.agent) return null;
    if (
      query.reportedSessionId === session.ref.sessionId ||
      query.dispatchId === session.locate.dispatchId ||
      query.transcriptMessageIds?.some((id) =>
        session.locate.transcriptMessageIds?.includes(id),
      )
    )
      return structuredClone(session.ref);
    return null;
  }
  /** Claude values are per-message; Codex values are session totals, never deltas. */
  append(attemptId: string, tokens: FakeUsageTokens, messageId?: string): void {
    const session = this.sessions.get(attemptId);
    if (!session)
      throw new PortError('permanent', 'attempt_not_found', 'Unknown attempt');
    for (const value of Object.values(tokens))
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('Invalid token count');
    const cumulative = session.ref.agent === 'codex';
    const externalKey = `usage:${session.ref.sessionId}:${cumulative ? 'cumulative' : (messageId ?? `message-${session.samples.length + 1}`)}`;
    if (
      !cumulative &&
      session.samples.some((sample) => sample.externalKey === externalKey)
    )
      return;
    session.samples.push({
      ...tokens,
      externalKey,
      cumulative,
      occurredAt: (
        this.options.clock?.now() ?? new Date('2026-01-01T00:00:00Z')
      ).toISOString(),
    });
  }
  async read(ref: UsageRef, cursor: UsageCursor | null) {
    const session = this.sessions.get(ref.attemptId);
    if (
      !session ||
      session.ref.sessionId !== ref.sessionId ||
      session.ref.agent !== ref.agent ||
      session.ref.file !== ref.file
    )
      throw new PortError(
        'permanent',
        'usage_not_found',
        'Unknown usage reference',
      );
    const prefix = `${JSON.stringify([ref.attemptId, ref.sessionId])}:`;
    const offset = cursor === null ? 0 : Number(cursor.slice(prefix.length));
    if (
      (cursor !== null && !cursor.startsWith(prefix)) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > session.samples.length
    )
      throw new PortError(
        'validation',
        'invalid_cursor',
        'Invalid usage cursor',
      );
    if (this.source === 'none')
      return {
        samples: [],
        cursor: UsageCursorSchema.parse(`${prefix}${offset}`),
      };
    const samples = session.samples.slice(offset);
    return {
      samples: structuredClone(
        ref.agent === 'codex' ? samples.slice(-1) : samples,
      ),
      cursor: UsageCursorSchema.parse(`${prefix}${session.samples.length}`),
    };
  }
}
export const createFakeUsage = (
  options: ConstructorParameters<typeof FakeUsage>[0] = {},
) => new FakeUsage(options);
