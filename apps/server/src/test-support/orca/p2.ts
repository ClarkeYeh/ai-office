import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { LedgerSchema, type ResourceLedger } from './ledger.js';
import { assertOutside } from './safety.js';

export const P2_CONFIRMATION =
  'PREPARE P2: no other workers; no pending update';
export function requireInteractiveConfirmation(input: {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  answer: string;
}): void {
  if (!input.stdinTTY || !input.stdoutTTY || input.answer !== P2_CONFIRMATION)
    throw new Error('P2 requires a live TTY and exact typed confirmation');
}
const StateSchema = z.object({
  format: z.literal(1),
  phase: z.literal('prepared'),
  preparedAt: z.string(),
  version: z.string().min(1),
  run: z.string(),
  shim: z.string(),
  consumerGeneration: z.number().int(),
  cursor: z.string().nullable(),
  lastSeq: z.number().int().nonnegative(),
  requestIds: z.array(z.string()).min(1),
  checkRequestId: z.string().nullable(),
  dispatchStates: z.record(z.string(), z.string()),
  ledger: LedgerSchema,
  backend: z
    .object({ pid: z.number().int().positive(), dataDir: z.string() })
    .nullable(),
});
export type P2State = z.infer<typeof StateSchema>;
export async function prepareP2(
  path: string,
  state: P2State,
  roots: string[],
  confirmation: Parameters<typeof requireInteractiveConfirmation>[0],
): Promise<void> {
  requireInteractiveConfirmation(confirmation);
  StateSchema.parse(state);
  if (
    !state.ledger.runs.includes(state.run) ||
    !state.ledger.shims.some((s) => s.id === state.shim)
  )
    throw new Error('P2 state must own its run and shim');
  await assertOutside(state.ledger.dataDir, roots);
  // The caller supplies a path inside the verified private dataDir.
  const { isWithin } = await import('./safety.js');
  if (!isWithin(state.ledger.dataDir, path))
    throw new Error('P2 state must be in private dataDir');
  await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
}
export async function resumeP2(path: string): Promise<P2State> {
  return StateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
/** T16 supplies production-specific observations/assertions, including inbox dedupe and recovery. */
export async function verifyP2(
  path: string,
  verify: (state: P2State) => Promise<void>,
  clean: (ledger: ResourceLedger) => Promise<void>,
): Promise<void> {
  const state = await resumeP2(path);
  try {
    await verify(state);
  } finally {
    await clean(state.ledger);
  }
}
