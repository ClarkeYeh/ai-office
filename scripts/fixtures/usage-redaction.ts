import { resolve, sep } from 'node:path';

const counterKeys = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cached_input_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const counter = (key: string, value: unknown): boolean =>
  counterKeys.has(key) &&
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0;

/** This exception is for the repository's provider usage fixtures, never runtime logs. */
export function isUsageFixture(path: string | undefined): boolean {
  return (
    path !== undefined &&
    resolve(path).startsWith(resolve('fixtures/usage') + sep)
  );
}

/** Restore only known numeric counters after normal secret/body sanitization. */
export function preserveUsageCounters(
  original: unknown,
  sanitized: unknown,
): unknown {
  if (Array.isArray(original) && Array.isArray(sanitized))
    return original.map((row, index) => preserveRecord(row, sanitized[index]));
  return preserveRecord(original, sanitized);
}
function preserveRecord(original: unknown, sanitized: unknown): unknown {
  const row = object(original),
    clean = object(sanitized);
  if (!row || !clean) return sanitized;
  if (row.type === 'assistant') {
    const usage = object(object(row.message)?.usage);
    const target = object(object(clean.message)?.usage);
    if (usage && target)
      for (const [key, value] of Object.entries(usage))
        if (counter(key, value)) target[key] = value;
  }
  if (row.type === 'event_msg' && object(row.payload)?.type === 'token_count') {
    const usage = object(object(object(row.payload)?.info)?.total_token_usage);
    const target = object(object(clean.payload)?.info);
    // The enclosing field is itself secret-like: only a pure, known counter object
    // can replace its redaction. Unknown fields or strings keep the whole object masked.
    if (
      usage &&
      target &&
      Object.entries(usage).length > 0 &&
      Object.entries(usage).every(([key, value]) => counter(key, value))
    )
      target.total_token_usage = { ...usage };
  }
  return sanitized;
}
