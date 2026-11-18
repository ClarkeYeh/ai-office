/**
 * M2_PLAN §5 P5b: under the owner's current Codex settings, an Orca Codex worker
 * keeps ORCA_TERMINAL_HANDLE / ORCA_PANE_KEY / CODEX_THREAD_ID, and they pass
 * the same comparison `resolveCaller` performs (worker-list terminal handle,
 * worker-show assignee pane key). Only key names and verdicts are printed.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { codexEnvironmentWarnings } from '../../config/index.js';
import type { OrcaHarness } from './harness.js';
import { requireValue } from './contract-live-cli.js';
import {
  drain,
  orcaHome,
  report,
  waitSettled,
  worktreePath,
} from './t16-live.js';
import { collectDispatchUsage } from './usage.js';

export const assertClean = true;

export async function run(h: OrcaHarness): Promise<void> {
  const sha = process.env.AIO_TEST_BASE_SHA;
  requireValue(sha, 'AIO_TEST_BASE_SHA required');
  const name = basename(h.ledger.dataDir);
  const shim = await h.createShim(orcaHome());
  const run = await h.createRun(shim, name);
  const branch = `ai-office-test/${name}`;
  await h.createWorktree(name, branch, sha);
  const workspace = h.ledger.worktrees.at(-1)!;
  const dir = await worktreePath(h, branch);
  const spec = [
    'This is an AI Office environment probe in a disposable test repository.',
    'Do not edit tracked files and do not start helpers.',
    'Run these two shell commands exactly as written, from this worktree:',
    "env | grep -E '^(ORCA_TERMINAL_HANDLE|ORCA_PANE_KEY|CODEX_THREAD_ID)=' | cut -d= -f1 | sort > aio-p5b-keys.txt",
    'printf \'%s\\n%s\\n\' "$ORCA_TERMINAL_HANDLE" "$ORCA_PANE_KEY" > aio-p5b-ident.txt',
    'Then report worker_done succeeded to your coordinator with a three-sentence summary: the probe ran two commands, no tracked files changed, nothing remains.',
  ].join('\n');
  const startedAt = new Date().toISOString();
  const started = await h.command([
    'orchestration',
    'worker-start',
    '--from',
    shim,
    '--agent',
    'codex',
    '--worktree',
    `id:${workspace.id}`,
    '--spec',
    spec,
    '--retry-request',
    randomUUID(),
    '--json',
    '--full',
  ]);
  const dispatch = started.dispatchId;
  requireValue(
    typeof dispatch === 'string' && started.state !== 'failed',
    'P5b worker did not start',
  );
  const files = ['aio-p5b-keys.txt', 'aio-p5b-ident.txt'];
  try {
    await waitSettled(h, dispatch, async () => {
      try {
        for (const file of files) await readFile(join(dir, file));
        return true;
      } catch {
        return false;
      }
    });
    const keys = (await readFile(join(dir, files[0]!), 'utf8'))
      .split('\n')
      .filter(Boolean);
    const [handle, paneKey] = (
      await readFile(join(dir, files[1]!), 'utf8')
    ).split('\n');
    const listed = await h.command([
      'orchestration',
      'worker-list',
      '--run',
      run,
      '--json',
      '--full',
    ]);
    const row = (
      listed.workers as
        | {
            dispatchId?: string;
            terminal?: string;
            agentTerminalHandle?: string;
          }[]
        | undefined
    )?.find((w) => w.dispatchId === dispatch);
    const shown = await h.command([
      'orchestration',
      'worker-show',
      '--dispatch',
      dispatch,
      '--json',
      '--full',
    ]);
    const assignee = shown.dispatch as { assigneePaneKey?: string } | undefined;
    const verdict = {
      keys,
      mode: (started.mode as { mode?: string } | undefined)?.mode,
      handleMatches:
        !!handle && (row?.terminal ?? row?.agentTerminalHandle) === handle,
      paneKeyMatches: !!paneKey && assignee?.assigneePaneKey === paneKey,
      predictedWarnings: codexEnvironmentWarnings(),
    };
    await report(h, 'P5b', verdict);
    requireValue(
      ['CODEX_THREAD_ID', 'ORCA_PANE_KEY', 'ORCA_TERMINAL_HANDLE'].every((k) =>
        keys.includes(k),
      ),
      'Codex worker lost identity variables',
    );
    requireValue(
      verdict.handleMatches && verdict.paneKeyMatches,
      'Identity double check failed',
    );
    requireValue(
      verdict.predictedWarnings.length === 0,
      'T11 predicted filtering, but the worker kept ORCA_*',
    );
    await drain(h, shim, run);
  } finally {
    for (const file of files) await rm(join(dir, file), { force: true });
    await collectDispatchUsage(h, [
      { agent: 'codex', attemptId: dispatch, dispatchId: dispatch, startedAt },
    ]);
  }
}
