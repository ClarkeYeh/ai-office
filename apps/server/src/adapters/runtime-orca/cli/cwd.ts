import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { guard } from '../errors.js';
/** Discovery is injected: its global read-only worktree-list uses the shared CLI budget. */
export class CwdGuard {
  readonly cwd: string;
  private paths: string[] = [];
  private checkedAt = -Infinity;
  private refresh: Promise<void> | undefined;
  constructor(
    dataDir: string,
    private readonly listPaths: () => Promise<string[]>,
    private readonly now: () => number = Date.now,
  ) {
    this.cwd = resolve(dataDir, 'cli-cwd');
  }
  async check(refresh = true): Promise<string> {
    await mkdir(this.cwd, { recursive: true });
    if (this.now() - this.checkedAt >= 60_000) {
      if (!refresh) throw guard('cwd_inventory_expired');
      this.refresh ??= this.listPaths()
        .then((paths) => {
          this.paths = paths;
          this.checkedAt = this.now();
        })
        .finally(() => {
          this.refresh = undefined;
        });
      await this.refresh;
    }
    const cwd = await realpath(this.cwd);
    for (const root of this.paths) {
      if (!isAbsolute(root)) throw guard('invalid_worktree_path');
      // Check lexical AND physical paths; symlinks must not bypass the guard.
      const paths = [resolve(root)];
      try {
        paths.push(await realpath(root));
      } catch {
        /* removed roots still checked lexically */
      }
      for (const path of paths) {
        for (const candidate of [this.cwd, cwd]) {
          const rel = relative(path, candidate);
          if (
            rel === '' ||
            (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
          )
            throw guard('cli_cwd_in_worktree');
        }
      }
    }
    return cwd;
  }
}
