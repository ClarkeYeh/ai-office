import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeEventSchema } from '../../../ports/runtime-events.js';
import { AIO_NAMESPACE } from '../../../ports/services.js';

/**
 * T6 cursor payload inside T3's `{v:1,data}` envelope (SPEC §11.5). Every batch
 * gets a new `n`, so `(session, cursor)` memo keys never repeat. `check.requestId`
 * is the next consuming check to issue (or the one still in flight); it survives
 * crashes because the cursor commits with the batch's events.
 */
export const CursorPayloadSchema = z.object({
  n: z.number().int().nonnegative(),
  run: z.string().min(1),
  check: z.object({ requestId: z.uuid() }),
  /** Highest ingested inbox `sequence` (check messages carry none). */
  lastSeq: z.number().int().nonnegative(),
  /**
   * Ids of the last mail ingested (FX-STATUS-CADENCE): a later inbox read
   * that returns it again is a no-op, so `lastSeq` need not be learned after
   * every check batch.
   */
  consumed: z.array(z.string()).default([]),
  /** dispatch → worker-read transcript cursor. */
  tx: z.record(z.string(), z.string()),
  /** dispatch or agent → last emitted state key (`unmanaged` for foreign dispatches). */
  seen: z.record(z.string(), z.string()),
  /** Unanswered questions; rebuildable from the inbox (never in the ledger). */
  questions: z.array(
    z.object({ id: z.string(), dispatch: z.string(), since: z.string() }),
  ),
  /**
   * Events of a spawn still in flight; `agent` holds the raw dispatch until resolved.
   * A question keeps only its message id: the body is refetched from the inbox on
   * release, so the persisted cursor never stores question text.
   */
  held: z.array(
    z.union([
      z.object({
        dispatch: z.string(),
        commandId: z.string(),
        event: RuntimeEventSchema,
      }),
      z.object({
        dispatch: z.string(),
        commandId: z.string(),
        question: z.object({ id: z.string(), occurredAt: z.string() }),
      }),
    ]),
  ),
});
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;
export type HeldItem = CursorPayload['held'][number];
export const heldKey = (item: HeldItem) =>
  'event' in item ? item.event.externalKey : `orca:msg:${item.question.id}`;

/** RFC 4122 version 5 (SHA-1) UUID. */
export function uuidV5(name: string, namespace = AIO_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Deterministic first check per run: a never-committed first batch replays. */
export const firstCheckId = (run: string) => uuidV5(`orca:check:${run}:0`);
/** The `UUIDv5(prev)` chain (M2 plan T6). */
export const nextCheckId = (previous: string) =>
  uuidV5(`orca:check:${previous}`);

export function initialPayload(run: string): CursorPayload {
  return {
    n: 0,
    run,
    check: { requestId: firstCheckId(run) },
    lastSeq: 0,
    consumed: [],
    tx: {},
    seen: {},
    questions: [],
    held: [],
  };
}
