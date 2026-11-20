import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Exclusive across worktrees. Malformed locks fail closed; only a dead PID is reclaimable. */
export async function acquireLiveLock(
  path: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await open(path, 'wx', 0o600);
      try {
        await fd.writeFile(content);
        await fd.sync();
      } finally {
        await fd.close();
      }
      return async () => {
        if ((await readFile(path, 'utf8')) !== content)
          throw new Error('Live lock ownership changed');
        await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('Cannot acquire GitHub live lock', { cause: error });
      const previous = await readFile(path, 'utf8');
      let pid: unknown;
      try {
        pid = (JSON.parse(previous) as { pid: unknown }).pid;
      } catch {
        throw new Error('Malformed live lock; manual inspection required', {
          cause: error,
        });
      }
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid live lock PID', { cause: error });
      try {
        process.kill(pid, 0);
        throw new Error('GitHub live suite already running', { cause: error });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
          throw new Error('GitHub live lock is held', { cause: e });
      }
      // Serialize stale reclaimers too: none can unlink a replacement lock.
      const reclaimPath = `${path}.reclaim`;
      let reclaim;
      try {
        reclaim = await open(reclaimPath, 'wx', 0o600);
      } catch {
        throw new Error('Live lock reclamation in progress');
      }
      try {
        if ((await readFile(path, 'utf8')) === previous) await unlink(path);
      } finally {
        await reclaim.close();
        await unlink(reclaimPath);
      }
    }
  }
  throw new Error('Cannot acquire GitHub live lock');
}
