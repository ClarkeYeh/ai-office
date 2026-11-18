/**
 * M2-T17 (§6.3 b, §27): the composed `--dev --runtime orca` backend refuses to
 * start when its Orca CLI cwd (`<AI_OFFICE_HOME>/cli-cwd`) lies inside an Orca
 * worktree — here the spike's main worktree. CLI-only; no agent is launched.
 * The temporary home is removed and the clone must be left clean.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '../../../main.js';
import type { OrcaHarness } from '../harness.js';
import { requireValue } from '../contract-live-cli.js';
import { writeReport } from './office.js';

const git = promisify(execFile);
export const assertClean = true;

export async function run(h: OrcaHarness): Promise<void> {
  const home = process.env.HOME;
  const bin = process.env.AIO_ORCA_BIN;
  requireValue(home, 'HOME required');
  requireValue(bin, 'AIO_ORCA_BIN required');
  const status = async () =>
    (
      await git('/usr/bin/git', [
        '-C',
        h.ledger.repoPath,
        'status',
        '--porcelain',
      ])
    ).stdout;
  assert.equal(await status(), '', 'spike clone must start clean');
  const inside = await mkdtemp(join(h.ledger.repoPath, '.aio-test-cwd-'));
  let error: unknown;
  const shims: string[] = [];
  try {
    await writeFile(
      join(inside, 'config.toml'),
      `[orca]\nbin = ${JSON.stringify(bin)}\npreventSleep = false\n`,
      { mode: 0o600 },
    );
    const server = await startServer({
      dev: true,
      runtime: 'orca',
      port: 0,
      env: { ...process.env, AI_OFFICE_HOME: inside },
      webDist: join(inside, 'no-web'),
      print: () => undefined,
      orcaHome: join(home, '.ai-office', 'orca-home'),
      testOnly: {
        // Must never run; if it does, the shim is ledgered for cleanup.
        onShimCreated: async (handle) => {
          shims.push(handle);
          h.ledger.shims.push({ id: handle, done: false });
          await h.persist();
        },
      },
    }).catch((e: unknown) => {
      error = e;
      return undefined;
    });
    await server?.close();
  } finally {
    await rm(inside, { recursive: true, force: true });
  }
  const report = {
    errorClass: error instanceof Error ? error.constructor.name : null,
    // Codes only; the guard's message names no path.
    errorCode: (error as { code?: unknown } | undefined)?.code ?? null,
    shimsCreated: shims.length,
    cloneCleanAfter: (await status()) === '',
  };
  await writeReport(h, 'cwd-guard', report);
  assert.equal(
    report.errorCode,
    'cli_cwd_in_worktree',
    'startup inside an Orca worktree must be refused by the cwd guard',
  );
  assert.equal(shims.length, 0, 'no shim may be created before the refusal');
  assert.ok(report.cloneCleanAfter, 'spike clone left clean');
}
