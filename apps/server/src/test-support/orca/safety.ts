import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GitCli } from '../../adapters/runtime-orca/git/index.js';

export const TEST_REPO_URL = 'https://github.com/ClarkeYeh/ai-office-spike';
export function repoIdentity(value: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)(ClarkeYeh\/ai-office-spike)(?:\.git)?\/?$/.exec(
      value.trim(),
    );
  if (!match)
    throw new Error('Harness requires the dedicated spike repository');
  return match[1]!;
}
export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}
export async function assertOutside(
  path: string,
  roots: readonly string[],
): Promise<void> {
  const physical = await realpath(path);
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => resolve(root));
    if (
      [resolve(root), canonical].some(
        (r) => isWithin(r, path) || isWithin(r, physical),
      )
    )
      throw new Error(
        'Harness path must be outside repositories and Orca worktrees',
      );
  }
}
export async function assertTestRepo(
  git: Pick<GitCli, 'originUrl'>,
  path: string,
  expected = TEST_REPO_URL,
): Promise<void> {
  if (!isAbsolute(path))
    throw new Error('Test repository path must be absolute');
  if (repoIdentity(await git.originUrl(path)) !== repoIdentity(expected))
    throw new Error('Test repository origin mismatch');
}
export function testBranch(branch: string, local = false): void {
  if (
    !(
      local
        ? /^(?:ai-office-test\/|aio-test-)[a-zA-Z0-9][a-zA-Z0-9/_-]*$/
        : /^ai-office-test\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/
    ).test(branch) ||
    branch.includes('//')
  )
    throw new Error('Non-test branch refused');
}
export function testWorktree(name: string, comment: string): void {
  if (!/^aio-test-[a-zA-Z0-9_-]+$/.test(name) || !comment.startsWith('aio:'))
    throw new Error('Non-test worktree refused');
}
export function requireOwned(
  id: string | undefined,
  owned: readonly string[],
): void {
  if (!id || !owned.includes(id))
    throw new Error('Resource is not owned by this harness');
}
