import { z } from 'zod';
import { contractMismatch, orcaError } from '../errors.js';
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export const EnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: JsonObjectSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);
export const WorktreeListSchema = z.object({
  worktrees: z.array(z.object({ path: z.string().min(1) })),
});
export const StatusSchema = z.object({
  runtime: z.object({ appVersion: z.string() }),
});
export function parseResult(stdout: string): Record<string, unknown> {
  let parsed: z.infer<typeof EnvelopeSchema>;
  try {
    parsed = EnvelopeSchema.parse(JSON.parse(stdout));
  } catch {
    throw contractMismatch();
  }
  if (!parsed.ok) throw orcaError(parsed.error.code);
  return parsed.result;
}
/** Receipt failure is not an exit-code failure and must not trigger a new request id. */
export function checkReceipt(
  args: readonly string[],
  result: Record<string, unknown>,
): void {
  const operation = args[0] === 'orchestration' ? args[1] : undefined;
  if (!['worker-start', 'send', 'worker-release'].includes(operation ?? ''))
    return;
  if (
    result.state === 'failed' ||
    result.state === 'outcome_unknown' ||
    result.state === 'release_unknown'
  ) {
    throw orcaError(result.state);
  }
  if (
    operation === 'worker-start' &&
    (typeof result.state !== 'string' || typeof result.dispatchId !== 'string')
  )
    throw contractMismatch();
}
