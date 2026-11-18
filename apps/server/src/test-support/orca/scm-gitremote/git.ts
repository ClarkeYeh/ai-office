import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PortError } from '../../../ports/errors.js';
import {
  assertTestRepo,
  claimedBranch,
  repoIdentity,
  testBranch,
} from '../safety.js';
import type { ResourceLedger } from '../ledger.js';

const execute = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execute(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'SCM test',
          GIT_AUTHOR_EMAIL: 'scm@example.invalid',
          GIT_COMMITTER_NAME: 'SCM test',
          GIT_COMMITTER_EMAIL: 'scm@example.invalid',
        },
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return result.stdout.trim();
  } catch {
    // Never retain argv, stdout, stderr or environment in an error.
    throw new PortError('conflict', 'git_failed', 'Test git operation failed');
  }
}
export type GitRemoteOptions = {
  /** An absolute local bare repository, or a harness-owned spike clone. */
  remote: string;
  defaultBranch?: string;
  harness?: { ledger: ResourceLedger; persist(): Promise<void> };
  /**
   * Offline (bare remote) only: claimed workflow namespaces. With a harness the
   * active claims come from its ledger instead (T17); never a wildcard.
   */
  namespaces?: () => readonly string[];
};
export class TestGitRemote {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly path: string,
    readonly options: GitRemoteOptions,
  ) {}
  static async create(options: GitRemoteOptions): Promise<TestGitRemote> {
    if (!isAbsolute(options.remote))
      throw new PortError(
        'guard',
        'remote',
        'Absolute test repository required',
      );
    if (
      !options.harness &&
      (await git(options.remote, ['rev-parse', '--is-bare-repository'])) !==
        'true'
    )
      throw new PortError('guard', 'remote', 'Local bare repository required');
    const path = await mkdtemp(join(tmpdir(), 'aio-test-scm-'));
    const instance = new TestGitRemote(path, options);
    try {
      await instance.verify();
      const remote = options.harness
        ? await git(options.remote, ['remote', 'get-url', 'origin'])
        : options.remote;
      await git(path, [
        'clone',
        '--no-local',
        '--no-checkout',
        '--',
        remote,
        '.',
      ]);
      return instance;
    } catch (error) {
      await instance.dispose();
      throw error;
    }
  }
  async verify(): Promise<void> {
    const harness = this.options.harness;
    if (!harness) return;
    if (
      process.env.CI ||
      process.env.AIO_REAL_ORCA !== '1' ||
      harness.ledger.repoPath !== this.options.remote
    )
      throw new PortError('guard', 'live_gate', 'Gated Orca harness required');
    await assertTestRepo(
      { originUrl: (path) => git(path, ['remote', 'get-url', 'origin']) },
      this.options.remote,
      harness.ledger.repoUrl,
    );
    repoIdentity(
      await git(this.options.remote, ['remote', 'get-url', '--push', 'origin']),
    );
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async dispose(): Promise<void> {
    await this.queue;
    await rm(this.path, { recursive: true, force: true });
  }
  async heads(): Promise<Map<string, string>> {
    await this.verify();
    return new Map(
      (await git(this.path, ['ls-remote', '--heads', 'origin']))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/);
          return [ref!.slice('refs/heads/'.length), sha!];
        }),
    );
  }
  async fetch(): Promise<void> {
    await git(this.path, [
      'fetch',
      '--prune',
      'origin',
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
  }
  /** Active T17 namespace claims: exact workflow shortIds, never `ai-office/*`. */
  claims(): readonly string[] {
    const harness = this.options.harness;
    return harness
      ? harness.ledger.namespaces.filter((n) => !n.done).map((n) => n.id)
      : (this.options.namespaces?.() ?? []);
  }
  guard(branch: string): void {
    try {
      testBranch(branch, false, this.claims());
    } catch {
      throw new PortError(
        'guard',
        'branch',
        'Only test branches may be written',
      );
    }
    if (branch === (this.options.defaultBranch ?? 'main'))
      throw new PortError(
        'guard',
        'default_branch',
        'Default branch is protected',
      );
  }
  async own(branch: string, creating = false): Promise<void> {
    this.guard(branch);
    await this.verify();
    const harness = this.options.harness;
    if (!harness) return;
    const entry = harness.ledger.remoteBranches.find(
      (b) => b.id === branch && !b.done,
    );
    if (entry) return;
    // T17: an active workflow-namespace claim proves ownership of every branch
    // in it (workers push their own); ledger it so cleanup deletes it.
    if (claimedBranch(branch, this.claims())) {
      harness.ledger.remoteBranches.push({ id: branch, done: false });
      await harness.persist();
      return;
    }
    if (!creating || (await this.heads()).has(branch))
      throw new PortError(
        'guard',
        'ownership',
        'Branch is not owned by this harness',
      );
    harness.ledger.remoteBranches.push({ id: branch, done: false });
    await harness.persist();
  }
  async push(branch: string, sha: string, expected: string): Promise<void> {
    if (
      ![sha, expected].every(
        (value) => value === '' || /^[0-9a-f]{40}$/.test(value),
      )
    )
      throw new PortError('guard', 'sha', 'Full commit SHA required');
    await this.own(branch);
    await git(this.path, [
      'push',
      `--force-with-lease=refs/heads/${branch}:${expected}`,
      'origin',
      `${sha}:refs/heads/${branch}`,
    ]);
  }
  async resolve(
    base: string,
    heads: Map<string, string>,
  ): Promise<string | null> {
    if (heads.has(base)) return heads.get(base)!;
    if (!/^[0-9a-f]{40}$/.test(base)) return null;
    try {
      return await git(this.path, [
        'rev-parse',
        '--verify',
        `${base}^{commit}`,
      ]);
    } catch {
      return null;
    }
  }
}
