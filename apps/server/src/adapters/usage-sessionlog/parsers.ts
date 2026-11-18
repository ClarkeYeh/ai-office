import { z } from 'zod';
import type { UsageSample } from '../../ports/usage.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const claude = z.object({
  timestamp,
  message: z.object({
    id: z.string().min(1),
    stop_reason: z.string().nullable().optional(),
    usage: z.object({
      input_tokens: count,
      output_tokens: count,
      cache_read_input_tokens: count.optional().default(0),
      cache_creation_input_tokens: count.optional().default(0),
    }),
  }),
});
const codex = z.object({
  timestamp,
  payload: z.object({
    info: z.object({
      total_token_usage: z.object({
        input_tokens: count,
        cached_input_tokens: count.optional().default(0),
        output_tokens: count,
        reasoning_output_tokens: count.optional(),
        total_tokens: count,
      }),
    }),
  }),
});
export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export type ParsedUsage = {
  id: string;
  complete: boolean;
  sample: UsageSample;
};

/** Deliberately project only counters and identity; never return provider content. */
export function parseUsage(
  row: unknown,
  agent: 'claude-code' | 'codex',
  sessionId: string,
): ParsedUsage | null {
  const entry = object(row);
  if (!entry || typeof entry.type !== 'string')
    throw new Error('Invalid record');
  if (agent === 'claude-code') {
    if (entry.type !== 'assistant') return null;
    const { message, timestamp } = claude.parse(row);
    return {
      id: message.id,
      complete: message.stop_reason != null,
      sample: {
        externalKey: `usage:${sessionId}:${message.id}`,
        occurredAt: timestamp,
        inputUncached: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens,
        cacheWrite: message.usage.cache_creation_input_tokens,
        cumulative: false,
      },
    };
  }
  if (
    entry.type !== 'event_msg' ||
    object(entry.payload)?.type !== 'token_count'
  )
    return null;
  // Codex emits empty token_count notifications before any usage is available.
  if (object(entry.payload)?.info === null) return null;
  const parsed = codex.parse(row);
  const usage = parsed.payload.info.total_token_usage;
  if (
    usage.cached_input_tokens > usage.input_tokens ||
    (usage.reasoning_output_tokens ?? 0) > usage.output_tokens ||
    usage.total_tokens !== usage.input_tokens + usage.output_tokens
  )
    throw new Error('Invalid counters');
  return {
    id: String(usage.total_tokens),
    complete: true,
    sample: {
      externalKey: `usage:codex:${sessionId}:${usage.total_tokens}`,
      occurredAt: parsed.timestamp,
      inputUncached: usage.input_tokens - usage.cached_input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cached_input_tokens,
      cacheWrite: 0,
      ...(usage.reasoning_output_tokens === undefined
        ? {}
        : { reasoning: usage.reasoning_output_tokens }),
      cumulative: true,
    },
  };
}
