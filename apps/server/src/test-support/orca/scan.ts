import { setTimeout as delay } from 'node:timers/promises';
import type { ExecResult } from '../../adapters/runtime-orca/cli/types.js';
import { claimedBranch, claimedWorktree } from './safety.js';

export interface ScanResource {
  kind: 'worktree' | 'shim' | 'localBranch' | 'remoteBranch';
  id: string;
  name: string;
}
const LIMIT = 100000;
const testBranch = /^(?:ai-office-test\/|aio-test-).+/;
function rows(output: ExecResult, key: string): Record<string, unknown>[] {
  const receipt = JSON.parse(output.stdout) as {
    ok?: boolean;
    result?: Record<string, unknown>;
  };
  const list = receipt.result?.[key];
  if (
    !receipt.ok ||
    !Array.isArray(list) ||
    list.length >= LIMIT ||
    receipt.result?.hasMore === true ||
    receipt.result?.truncated === true
  )
    throw new Error('Incomplete janitor inventory');
  return list.map((row: unknown) => {
    if (!row || typeof row !== 'object')
      throw new Error('Invalid janitor inventory');
    return row as Record<string, unknown>;
  });
}
/** Discovery only: names are not proof of ownership and never authorize deletion. */
export async function scanResources(
  repoPath: string,
  shimPath: string,
  execute: (
    kind: 'orca' | 'git',
    args: readonly string[],
  ) => Promise<ExecResult>,
  /** Composed-backend shim markers (`aio-shim:<hash>`) owned by this ledger. */
  markers: readonly string[] = [],
  /** T17 claimed workflow namespaces (exact shortIds, never a wildcard). */
  namespaces: readonly string[] = [],
): Promise<ScanResource[]> {
  const found: ScanResource[] = [];
  const worktrees = rows(
    await execute('orca', [
      'worktree',
      'list',
      '--repo',
      `path:${repoPath}`,
      '--limit',
      String(LIMIT),
      '--json',
    ]),
    'worktrees',
  );
  for (const row of worktrees) {
    const name = row.displayName ?? row.name;
    if (
      typeof name !== 'string' ||
      !(name.startsWith('aio-test-') || claimedWorktree(name, namespaces))
    )
      continue;
    if (typeof row.id !== 'string')
      throw new Error('Worktree inventory missing ID');
    found.push({ kind: 'worktree', id: row.id, name });
  }
  const terminals = rows(
    await execute('orca', [
      'terminal',
      'list',
      '--worktree',
      `path:${shimPath}`,
      '--limit',
      String(LIMIT),
      '--json',
    ]),
    'terminals',
  );
  for (const row of terminals) {
    // Closed panes can remain in the inventory until persistence catches up.
    if (row.exitCause != null || row.connected === false) continue;
    const title = row.title ?? row.paneTitle;
    if (
      typeof title !== 'string' ||
      !(
        /^aio-test-shim(?:$|[- :])/.test(title) ||
        markers.some((marker) => title.endsWith(` ${marker}`))
      )
    )
      continue;
    if (typeof row.handle !== 'string')
      throw new Error('Terminal inventory missing handle');
    found.push({ kind: 'shim', id: row.handle, name: title });
  }
  const local = await execute('git', [
    '-C',
    repoPath,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/ai-office-test/',
    'refs/heads/aio-test-*',
    ...namespaces.flatMap((ns) => [
      `refs/heads/ai-office/${ns}/`,
      `refs/heads/ai-office/${ns}-*`,
    ]),
  ]);
  const remote = await execute('git', [
    '-C',
    repoPath,
    'ls-remote',
    '--heads',
    'origin',
    'refs/heads/ai-office-test/*',
    'refs/heads/aio-test-*',
    ...namespaces.flatMap((ns) => [
      `refs/heads/ai-office/${ns}/*`,
      `refs/heads/ai-office/${ns}-*`,
    ]),
  ]);
  if (local.exitCode !== 0 || remote.exitCode !== 0)
    throw new Error('Cannot scan test branches');
  for (const branch of local.stdout
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => testBranch.test(v) || claimedBranch(v, namespaces)))
    found.push({ kind: 'localBranch', id: branch, name: branch });
  for (const line of remote.stdout.split('\n').filter(Boolean)) {
    const ref = /^[a-f0-9]+\s+refs\/heads\/(.+)$/.exec(line)?.[1];
    if (!ref) throw new Error('Invalid remote branch inventory');
    if (testBranch.test(ref) || claimedBranch(ref, namespaces))
      found.push({ kind: 'remoteBranch', id: ref, name: ref });
  }
  return found;
}

/** Briefly tolerate close/list propagation, but never hide persistent live shims. */
export async function assertScanClean(
  scan: () => Promise<ScanResource[]>,
  wait: (ms: number) => Promise<unknown> = delay,
): Promise<void> {
  const deadline = Date.now() + 3000;
  for (let attempt = 0; ; attempt++) {
    const resources = await scan();
    if (!resources.length) return;
    const remaining = deadline - Date.now();
    if (
      resources.some((r) => r.kind !== 'shim') ||
      attempt >= 12 ||
      remaining <= 0
    )
      throw new Error('Scanned resources remain after cleanup');
    await wait(Math.min(250, remaining));
  }
}
