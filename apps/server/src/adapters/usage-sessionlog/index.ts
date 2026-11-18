import { open } from 'node:fs/promises';
import { z } from 'zod';
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
import { locateSession } from './locate.js';
import type { SessionDirectories } from './locate.js';
import { object, parseUsage } from './parsers.js';
import type { ParsedUsage } from './parsers.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pendingSchema = z
  .object({
    id: z.string(),
    complete: z.boolean(),
    sample: z
      .object({
        externalKey: z.string(),
        occurredAt: z.iso.datetime({ offset: true }),
        inputUncached: count,
        output: count,
        cacheRead: count,
        cacheWrite: count,
        cumulative: z.boolean(),
      })
      .strict(),
  })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    identity: z.string(),
    offset: count,
    pending: z.array(pendingSchema),
  })
  .strict();
const MAX_READ_BYTES = 4 * 1024 * 1024;
export type SessionLogUsageOptions = SessionDirectories & { clock?: Clock };

/** Read-only UsagePort. Cursors retain byte offsets and unfinished numeric usage only. */
export class SessionLogUsage implements UsagePort {
  private readonly failedFiles = new Set<string>();
  constructor(private readonly options: SessionLogUsageOptions = {}) {}
  capabilities(): ReturnType<UsagePort['capabilities']> {
    const verified = this.failedFiles.size === 0;
    return {
      source: verified ? 'session-log' : 'none',
      agents: ['claude-code', 'codex'],
      formatVerified: verified,
    };
  }
  locate(query: UsageLocateRef): Promise<UsageRef | null> {
    return locateSession(this.options, query, this.now());
  }
  async read(ref: UsageRef, cursor: UsageCursor | null) {
    const identity = JSON.stringify([
      ref.attemptId,
      ref.agent,
      ref.sessionId,
      ref.file,
    ]);
    let state: z.infer<typeof cursorSchema>;
    try {
      state =
        cursor === null
          ? { version: 1, identity, offset: 0, pending: [] }
          : cursorSchema.parse(JSON.parse(cursor));
      if (state.identity !== identity) throw new Error();
    } catch {
      throw new PortError(
        'validation',
        'invalid_usage_cursor',
        'Invalid usage cursor',
      );
    }
    try {
      const file = await open(ref.file, 'r');
      try {
        const info = await file.stat();
        if (!info.isFile() || state.offset > info.size) throw new Error();
        const bytes = Buffer.alloc(
          Math.min(MAX_READ_BYTES, info.size - state.offset),
        );
        const { bytesRead } = await file.read(
          bytes,
          0,
          bytes.length,
          state.offset,
        );
        const data = bytes.subarray(0, bytesRead);
        let consumed = data.lastIndexOf(10) + 1;
        const atEnd = state.offset + bytesRead === info.size;
        const idle = atEnd && this.now() - info.mtimeMs >= 30_000;
        // A final line without newline is safe to parse only after the writer is idle.
        if (idle) consumed = bytesRead;
        if (!consumed && bytesRead === MAX_READ_BYTES) throw new Error();
        const pending = new Map<string, ParsedUsage>(
          state.pending.map((p) => [p.id, p]),
        );
        const samples: UsageSample[] = [];
        for (const line of data
          .subarray(0, consumed)
          .toString('utf8')
          .split('\n')) {
          if (!line.trim()) continue;
          const row: unknown = JSON.parse(line);
          const parsed = parseUsage(row, ref.agent, ref.sessionId);
          if (ref.agent === 'codex') {
            if (parsed) samples.push(parsed.sample);
            continue;
          }
          // A new user or assistant message closes a previously interrupted message.
          if (object(row)?.type === 'user' || parsed) {
            for (const [id, previous] of pending)
              if (id !== parsed?.id) previous.complete = true;
          }
          if (parsed) pending.set(parsed.id, parsed);
        }
        for (const [id, value] of pending) {
          if (value.complete || idle) {
            samples.push(value.sample);
            pending.delete(id);
          }
        }
        const next = UsageCursorSchema.parse(
          JSON.stringify({
            version: 1,
            identity,
            offset: state.offset + consumed,
            pending: [...pending.values()],
          }),
        );
        this.failedFiles.delete(ref.file);
        return { samples, cursor: next };
      } finally {
        await file.close();
      }
    } catch {
      this.failedFiles.add(ref.file);
      // Do not include the filesystem error, JSON input, Zod issues, or a cause.
      throw new PortError(
        'transient',
        'usage_unavailable',
        'Session usage unavailable',
        true,
      );
    }
  }
  private now(): number {
    return (this.options.clock?.now() ?? new Date()).getTime();
  }
}
export const createSessionLogUsage = (options: SessionLogUsageOptions = {}) =>
  new SessionLogUsage(options);
