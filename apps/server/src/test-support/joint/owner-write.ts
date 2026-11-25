import type { Json } from '../orca/t17/checks.js';

/** The guarded transport's refusal of an object it has not ledgered. */
const NOT_LEDGERED = 'Object not in this ledger';

/**
 * An owner write on a backend-created object (M5-T12): the guarded transport
 * accepts it only once the object is in the run's ledger, and the backend can
 * create the object in the very poll the owner policy acts on (T12 #1: the
 * conclusion Issue and its gate, the same second). Import first; on a miss,
 * import fresh events and retry once; still missing fails as before.
 */
export async function ledgeredWrite(
  importNow: (log: Json[]) => Promise<void>,
  log: Json[],
  fresh: () => Promise<Json[]>,
  write: () => Promise<void>,
): Promise<void> {
  await importNow(log);
  try {
    await write();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== NOT_LEDGERED)
      throw error;
    await importNow(await fresh());
    await write();
  }
}
