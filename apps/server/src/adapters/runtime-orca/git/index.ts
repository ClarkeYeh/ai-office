import { isAbsolute } from 'node:path';
import { PortError } from '../../../ports/errors.js';
import { guard } from '../errors.js';
import { subprocessEnv } from '../env-allowlist.js';
import type { CwdGuard } from '../cli/cwd.js';
import type { Exec } from '../cli/types.js';
export interface GitWorktree {
  path: string;
  branch?: string;
  head?: string;
}
export interface GitCli {
  fetch(repo: string, branch: string): Promise<void>;
  revParse(repo: string, ref: string): Promise<string>;
  localBranch(repo: string, branch: string): Promise<string | null>;
  isAncestor(
    repo: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean>;
  status(repo: string): Promise<string[]>;
  originUrl(repo: string): Promise<string>;
  directories(repo: string): Promise<{ commonDir: string; topLevel: string }>;
  worktrees(repo: string): Promise<GitWorktree[]>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  createBranch(repo: string, branch: string, sha: string): Promise<void>;
}
function ref(value: string): string {
  if (
    !value ||
    value.startsWith('-') ||
    /[\s\x00-\x1f~^:?*\[\\]/.test(value) ||
    value.includes('..') ||
    value.includes('@{')
  )
    throw guard('invalid_git_ref');
  return value;
}
function branchName(value: string): string {
  ref(value);
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes('//') ||
    value.split('/').some((s) => s.startsWith('.'))
  )
    throw guard('invalid_git_branch');
  return value;
}
export class DefaultGitCli implements GitCli {
  constructor(
    private readonly options: {
      exec: Exec;
      cwdGuard: CwdGuard;
      env: NodeJS.ProcessEnv;
      bin?: string;
      passthrough?: readonly string[];
    },
  ) {}
  private async execute(
    repo: string,
    args: string[],
    fetch = false,
    accepted = [0],
  ) {
    if (!isAbsolute(repo)) throw guard('git_repo_must_be_absolute');
    const result = await this.options.exec.run({
      bin: this.options.bin ?? 'git',
      args: ['-C', repo, ...args],
      cwd: await this.options.cwdGuard.check(),
      env: subprocessEnv(
        this.options.env,
        fetch
          ? (this.options.passthrough ?? ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME'])
          : [],
      ),
      timeoutMs: 60_000,
    });
    if (result.exitCode === null || !accepted.includes(result.exitCode))
      throw new PortError(
        fetch ? 'transient' : 'permanent',
        'git_command_failed',
        'Git command failed',
        fetch,
      );
    return result;
  }
  async fetch(repo: string, branch: string): Promise<void> {
    await this.execute(repo, ['fetch', 'origin', branchName(branch)], true);
  }
  async revParse(repo: string, revision: string): Promise<string> {
    return (
      await this.execute(repo, ['rev-parse', '--verify', ref(revision)])
    ).stdout.trim();
  }
  async localBranch(repo: string, branch: string): Promise<string | null> {
    const result = await this.execute(
      repo,
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName(branch)}`],
      false,
      [0, 1],
    );
    return result.exitCode === 1 ? null : result.stdout.trim();
  }
  async isAncestor(
    repo: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    return (
      (
        await this.execute(
          repo,
          ['merge-base', '--is-ancestor', ref(ancestor), ref(descendant)],
          false,
          [0, 1],
        )
      ).exitCode === 0
    );
  }
  async status(repo: string): Promise<string[]> {
    const entries = (
      await this.execute(repo, ['status', '--porcelain', '-z'])
    ).stdout.split('\0');
    const names: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry) continue;
      names.push(entry.slice(3));
      if (/^[RC]|^.[RC]/.test(entry)) {
        const old = entries[++i];
        if (old) names.push(old);
      }
    }
    return names;
  }
  async originUrl(repo: string): Promise<string> {
    return (
      await this.execute(repo, ['remote', 'get-url', 'origin'])
    ).stdout.trim();
  }
  async directories(repo: string) {
    const [commonDir, topLevel] = (
      await this.execute(repo, [
        'rev-parse',
        '--git-common-dir',
        '--show-toplevel',
      ])
    ).stdout
      .trimEnd()
      .split('\n');
    if (!commonDir || !topLevel) throw guard('git_directories_invalid');
    return { commonDir, topLevel };
  }
  async worktrees(repo: string): Promise<GitWorktree[]> {
    const raw = (
      await this.execute(repo, ['worktree', 'list', '--porcelain', '-z'])
    ).stdout;
    const result: GitWorktree[] = [];
    let current: GitWorktree | undefined;
    for (const line of raw.split('\0')) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice(9) };
        result.push(current);
      } else if (current && line.startsWith('branch '))
        current.branch = line.slice(7);
      else if (current && line.startsWith('HEAD '))
        current.head = line.slice(5);
    }
    return result;
  }
  async deleteBranch(repo: string, branch: string): Promise<void> {
    branchName(branch);
    if (!(
      branch.startsWith('ai-office/') ||
      branch.startsWith('ai-office-test/') ||
      branch.startsWith('aio-')
    ))
      throw guard('branch_not_managed');
    if (
      (await this.worktrees(repo)).some(
        (wt) => wt.branch === `refs/heads/${branch}`,
      )
    )
      throw guard('branch_in_use');
    if (
      !(await this.isAncestor(
        repo,
        `refs/heads/${branch}`,
        `refs/remotes/origin/${branch}`,
      ))
    )
      throw guard('branch_unpushed');
    await this.execute(repo, ['branch', '-D', branch]);
  }
  /** Day-1 P8 primary path: pre-create local W at the pinned SHA. No force. */
  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw guard('invalid_git_sha');
    await this.execute(repo, ['branch', branchName(branch), sha]);
  }
}
