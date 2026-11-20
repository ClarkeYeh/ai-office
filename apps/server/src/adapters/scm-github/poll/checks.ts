import type { z } from 'zod';
import type { checkRunsSchema, combinedStatusSchema } from './schemas.js';
export type ChecksStatus = 'pending' | 'success' | 'failure' | 'none';
const failed = new Set([
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
]);
/**
 * §4.4 step 5. The combined status is `pending` when no status exists (G7), so
 * "none" is judged from empty lists, never from the combined `state`.
 */
export function rollupChecks(
  runs: z.infer<typeof checkRunsSchema>,
  status: z.infer<typeof combinedStatusSchema>,
): ChecksStatus {
  if (runs.check_runs.length === 0 && status.statuses.length === 0)
    return 'none';
  const states = [
    ...runs.check_runs.map((run) =>
      run.status === 'completed' ? (run.conclusion ?? 'pending') : 'pending',
    ),
    ...status.statuses.map((s) => s.state),
  ];
  if (states.some((s) => failed.has(s))) return 'failure';
  if (
    states.some((s) => !['success', 'neutral', 'skipped', 'stale'].includes(s))
  )
    return 'pending';
  return 'success';
}
