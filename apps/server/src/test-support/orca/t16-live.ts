/** M2-T16 shared helpers. Every Orca effect goes through T8's ownership gate. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { OrcaCli } from '../../adapters/runtime-orca/cli/types.js';
import { ShimCoordinatorIdentity } from '../../adapters/runtime-orca/coordinator-identity/shim.js';
import type { OrcaHarness } from './harness.js';
import { requireValue } from './contract-live-cli.js';

const exec = promisify(execFile);

export function orcaHome(): string {
  const home = process.env.HOME;
  requireValue(home, 'HOME required for the already registered shim folder');
  return join(home, '.ai-office', 'orca-home');
}

/** An owned test worktree's path, read from git (Orca inventory is not gated). */
export async function worktreePath(
  h: OrcaHarness,
  branch: string,
): Promise<string> {
  const { stdout } = await exec('git', [
    '-C',
    h.ledger.repoPath,
    'worktree',
    'list',
    '--porcelain',
  ]);
  for (const block of stdout.split('\n\n')) {
    const lines = block.split('\n');
    if (lines.includes(`branch refs/heads/${branch}`))
      return lines[0]!.replace(/^worktree /, '');
  }
  throw new Error('Owned test worktree not found');
}

/**
 * The production T4 identity bound to one harness shim. Its state is seeded so
 * no shim is created or adopted; run-show/run-use go through the command gate.
 */
export function identityFor(
  h: OrcaHarness,
  shim: string,
): ShimCoordinatorIdentity {
  const store = new Map<string, unknown>([
    [
      'orca:shim',
      {
        v: 1,
        handle: shim,
        incarnationId: null,
        location: orcaHome(),
        history: [shim],
        runs: {},
      },
    ],
  ]);
  const cli: OrcaCli = {
    async run(args, options, schema) {
      const extra =
        options.kind === 'mutate'
          ? [
              '--from',
              shim,
              '--retry-request',
              options.requestId ?? randomUUID(),
            ]
          : [];
      const full = args.includes('--full') ? [] : ['--full'];
      const result = await h.command([...args, ...extra, '--json', ...full]);
      return {
        result: (schema ? schema.parse(result) : result) as never,
        exitCode: 0,
      };
    },
  };
  return new ShimCoordinatorIdentity({
    cli,
    dataDir: h.ledger.dataDir,
    orcaHome: orcaHome(),
    shimLocation: 'folder-workspace',
    state: {
      read: (scope) => store.get(scope) ?? null,
      write: (scope, value) => store.set(scope, value),
    },
  });
}

/** Non-consuming wait for a dispatch to settle; check may be fenced by a hijack. */
export async function waitSettled(
  h: OrcaHarness,
  dispatch: string,
  ready: () => Promise<boolean> = async () => true,
  limitMs = 600_000,
): Promise<string> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const shown = await h.command([
      'orchestration',
      'worker-show',
      '--dispatch',
      dispatch,
      '--json',
      '--full',
    ]);
    const status = String(
      (shown.dispatch as { status?: unknown } | undefined)?.status,
    );
    if (
      ['completed', 'failed', 'cancelled', 'succeeded'].includes(status) &&
      (await ready())
    )
      return status;
    await delay(10_000);
  }
  throw new Error('Test worker did not settle within the active wait window');
}

/** Drains run mail through the owned shim so cleanup leaves no unread messages. */
export async function drain(
  h: OrcaHarness,
  shim: string,
  run: string,
): Promise<{ type: string; payload?: string }[]> {
  const batch = await h.command([
    'orchestration',
    'check',
    '--terminal',
    shim,
    '--run',
    run,
    '--wait',
    '--timeout-ms',
    '5000',
    '--retry-request',
    randomUUID(),
    '--json',
    '--full',
  ]);
  return Array.isArray(batch.messages)
    ? (batch.messages as { type: string; payload?: string }[])
    : [];
}

/** Verdicts (codes and booleans only) in the private dataDir; vitest may hide stdout. */
export async function report(
  h: OrcaHarness,
  name: string,
  verdict: unknown,
): Promise<void> {
  console.info(`[${name}] ${JSON.stringify(verdict)}`);
  await writeFile(
    join(h.ledger.dataDir, `${name}-verdict.json`),
    JSON.stringify(verdict, null, 2) + '\n',
    { mode: 0o600 },
  );
}
