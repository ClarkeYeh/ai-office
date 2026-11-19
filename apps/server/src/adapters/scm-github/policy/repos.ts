import { PortError } from '../../../ports/errors.js';
export type GithubRepo = { owner: string; name: string };
const key = (repo: GithubRepo) =>
  `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
/** Registration grants temporary read access; only successful registration grants writes. */
export class RepoAllowlist {
  private registered = new Set<string>();
  private inspecting = new Map<string, number>();
  constructor(repos: readonly GithubRepo[] = []) {
    for (const repo of repos) this.register(repo);
  }
  register(repo: GithubRepo): void {
    this.registered.add(key(repo));
  }
  remove(repo: GithubRepo): void {
    this.registered.delete(key(repo));
  }
  async inspect<T>(repo: GithubRepo, operation: () => Promise<T>): Promise<T> {
    const id = key(repo);
    this.inspecting.set(id, (this.inspecting.get(id) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const count = (this.inspecting.get(id) ?? 1) - 1;
      if (count) this.inspecting.set(id, count);
      else this.inspecting.delete(id);
    }
  }
  assert(repo: GithubRepo, write: boolean): void {
    const id = key(repo);
    if (!this.registered.has(id) && (write || !this.inspecting.has(id)))
      throw new PortError(
        'guard',
        'repo_not_allowed',
        'Repository is not allowed',
      );
  }
}
