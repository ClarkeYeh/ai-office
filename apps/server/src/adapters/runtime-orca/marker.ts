import { createHash } from 'node:crypto';

/**
 * Orca 1.4.259 stores task titles truncated to 80 characters ("…" suffix) in
 * every task-list view (M2-T17 D7). Engine command ids reach ~100 characters,
 * so the Orca-visible correlation marker is a fixed-length digest placed first:
 * `aio:<16 hex>` (20 characters) is never truncated. 16 hex (64 bits) also
 * stays under the redactor's 20-character high-entropy scan, so sanitized
 * recordings and redacted logs keep markers readable.
 */
export const ORCA_TITLE_MAX = 80;

export const markerTag = (commandId: string): string =>
  createHash('sha256').update(commandId).digest('hex').slice(0, 16);

/** The token after a leading `aio:` (a digest, or a legacy raw command id). */
export const markerToken = (title: string): string | undefined =>
  /^aio:([^\s]+)(?:\s|$)/.exec(title)?.[1];

/**
 * A command id and a marker token (or a ledger entry recovered from one)
 * denote the same command: equal, or one is the other's digest.
 */
export const sameCommand = (a: string, b: string): boolean =>
  a === b || markerTag(a) === b || a === markerTag(b);
