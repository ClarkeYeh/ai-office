import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { testBranch, testWorktree } from './safety.js';

const resource = z.object({
  id: z.string().min(1),
  done: z.boolean().default(false),
});
export const LedgerSchema = z.object({
  format: z.literal(1),
  repoPath: z.string(),
  repoUrl: z.string(),
  dataDir: z.string(),
  runs: z.array(z.string()),
  requests: z.array(z.string()).default([]),
  messages: z.array(z.string()).default([]),
  pending: z.array(z.object({ id: z.string(), kind: z.string() })).default([]),
  dispatches: z.array(resource.extend({ stopped: z.boolean().default(false) })),
  worktrees: z.array(
    resource.extend({
      name: z.string(),
      comment: z.string(),
      branch: z.string(),
    }),
  ),
  shims: z.array(resource),
  remoteBranches: z.array(resource),
  localBranches: z.array(resource),
  tasks: z.array(resource),
  usage: z.array(
    z.object({
      provider: z.string(),
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
    }),
  ),
});
export type ResourceLedger = z.infer<typeof LedgerSchema>;
export function emptyLedger(
  repoPath: string,
  repoUrl: string,
  dataDir: string,
): ResourceLedger {
  return {
    format: 1,
    repoPath,
    repoUrl,
    dataDir,
    runs: [],
    requests: [],
    messages: [],
    pending: [],
    dispatches: [],
    worktrees: [],
    shims: [],
    remoteBranches: [],
    localBranches: [],
    tasks: [],
    usage: [],
  };
}
export async function saveLedger(
  path: string,
  ledger: ResourceLedger,
): Promise<void> {
  LedgerSchema.parse(ledger);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger), {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, path);
}
export async function loadLedger(path: string): Promise<ResourceLedger> {
  return LedgerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
export interface CleanupDriver {
  stop(id: string): Promise<void>;
  release(id: string): Promise<void>;
  removeWorktree(id: string): Promise<void>;
  closeShim(id: string): Promise<void>;
  deleteRemote(branch: string): Promise<void>;
  deleteLocal(branch: string): Promise<void>;
  failTask(id: string): Promise<void>;
}
export function leftovers(
  ledger: ResourceLedger,
): { kind: string; id: string }[] {
  return ledger.pending
    .map((p) => ({ kind: `pending:${p.kind}`, id: p.id }))
    .concat(
      (
        [
          'dispatches',
          'worktrees',
          'shims',
          'remoteBranches',
          'localBranches',
          'tasks',
        ] as const
      ).flatMap((kind) =>
        ledger[kind].filter((r) => !r.done).map((r) => ({ kind, id: r.id })),
      ),
    );
}
/** Persist each successful step; a failed stop prevents release and workspace removal. */
export async function cleanup(
  ledger: ResourceLedger,
  driver: CleanupDriver,
  persist: () => Promise<void>,
): Promise<void> {
  for (const item of ledger.dispatches.filter((r) => !r.done)) {
    if (!item.stopped) {
      await driver.stop(item.id);
      item.stopped = true;
      await persist();
    }
    await driver.release(item.id);
    item.done = true;
    await persist();
  }
  for (const item of ledger.worktrees.filter((r) => !r.done)) {
    testWorktree(item.name, item.comment);
    testBranch(item.branch);
    await driver.removeWorktree(item.id);
    item.done = true;
    await persist();
  }
  for (const [items, action] of [
    [ledger.tasks, (id: string) => driver.failTask(id)],
    [ledger.shims, (id: string) => driver.closeShim(id)],
    [
      ledger.remoteBranches,
      async (id: string) => {
        testBranch(id);
        await driver.deleteRemote(id);
      },
    ],
    [
      ledger.localBranches,
      async (id: string) => {
        testBranch(id, true);
        await driver.deleteLocal(id);
      },
    ],
  ] as const) {
    for (const item of items.filter((r) => !r.done)) {
      await action(item.id);
      item.done = true;
      await persist();
    }
  }
}
