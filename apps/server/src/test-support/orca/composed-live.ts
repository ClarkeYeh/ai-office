/** Integrator-only composed backend smoke. All effects go through T8's ledger. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../../main.js';
import { composedShimOptions } from './composed-shim-seam.js';
import { requireValue } from './contract-live-cli.js';
import type { OrcaHarness } from './harness.js';

/** The runner cleans the ledger, then asserts ledger 0 and scan 0. */
export const assertClean = true;

export async function run(h: OrcaHarness): Promise<void> {
  const home = process.env.HOME;
  const bin = process.env.AIO_ORCA_BIN;
  requireValue(home, 'HOME required for the already registered shim folder');
  requireValue(bin, 'AIO_ORCA_BIN required for the composed backend');
  // Isolated AI_OFFICE_HOME inside the private dataDir; never ~/.ai-office.
  const backendHome = join(h.ledger.dataDir, 'backend');
  await mkdir(backendHome, { recursive: true, mode: 0o700 });
  await writeFile(
    join(backendHome, 'config.toml'),
    `[orca]\nbin = ${JSON.stringify(bin)}\npreventSleep = false\n`,
    { mode: 0o600, flag: 'wx' },
  );
  const effects = await h.composedBackend(backendHome);
  const server = await startServer({
    dev: true,
    runtime: 'orca',
    port: 0,
    env: { ...process.env, AI_OFFICE_HOME: backendHome },
    webDist: join(backendHome, 'no-web'),
    print: () => undefined,
    ...composedShimOptions({
      orcaHome: join(home, '.ai-office', 'orca-home'),
      onShimCreated: effects.shim,
    }),
  });
  try {
    // Startup ensured the shim: it must be ledgered and visible to the scan.
    await effects.settle();
    const scanned = await h.scan();
    requireValue(
      h.ledger.shims.some(
        (s) =>
          !s.done && scanned.some((r) => r.kind === 'shim' && r.id === s.id),
      ),
      'Composed shim missing from the scoped inventory',
    );
  } finally {
    await server.close();
  }
}
