/** Integrator-only CLI scenario. All effects go through T8's ownership gate. */
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import type { OrcaHarness } from './harness.js';
export function requireValue(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
export async function setup(h: OrcaHarness) {
  const home = process.env.HOME;
  requireValue(home, 'HOME required for the already registered shim folder');
  const shim = await h.createShim(join(home, '.ai-office', 'orca-home'));
  const run = await h.createRun(shim, basename(h.ledger.dataDir));
  return { shim, run };
}
export async function run(h: OrcaHarness): Promise<void> {
  const { shim, run } = await setup(h);
  const id = randomUUID();
  const create = [
    'orchestration',
    'run-create',
    '--from',
    shim,
    '--objective',
    `aio-test-contract-${basename(h.ledger.dataDir)}`,
    '--retry-request',
    id,
    '--json',
    '--full',
  ];
  const first = await h.command(create);
  const again = await h.command(create);
  requireValue(
    (first.run as { id?: string }).id === (again.run as { id?: string }).id,
    'run-create replay changed identity',
  );
  const mismatch = [...create];
  mismatch[mismatch.indexOf('--objective') + 1] += '-changed';
  const rejection = await h.command(mismatch, 'request_mismatch');
  requireValue(
    rejection.rejected === 'request_mismatch',
    'Missing mismatch rejection',
  );
  const checked = await h.command([
    'orchestration',
    'check',
    '--terminal',
    shim,
    '--run',
    run,
    '--wait',
    '--timeout-ms',
    '100',
    '--retry-request',
    randomUUID(),
    '--json',
    '--full',
  ]);
  requireValue(
    checked.timedOut === true &&
      Array.isArray(checked.messages) &&
      !checked.messages.length,
    'Empty check did not time out',
  );
  // Close only the shim created in this ledger; restore using a new owned shim.
  await h.command(['terminal', 'close', '--terminal', shim, '--json']);
  h.ledger.shims.find((s) => s.id === shim)!.done = true;
  await h.persist();
  const replacement = await h.createShim(
    join(process.env.HOME!, '.ai-office', 'orca-home'),
  );
  await h.command([
    'orchestration',
    'run-use',
    '--id',
    run,
    '--from',
    replacement,
    '--retry-request',
    randomUUID(),
    '--json',
    '--full',
  ]);
  const shown = await h.command([
    'orchestration',
    'run-show',
    '--id',
    run,
    '--json',
    '--full',
  ]);
  requireValue(
    (shown.run as { coordinator_handle?: string }).coordinator_handle ===
      replacement,
    'Run not rebound to replacement shim',
  );
}
