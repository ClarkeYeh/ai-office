import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, ghToken } from './process.js';
import { Ledger } from './ledger.js';
import { REPO, assertBranch, assertRemote } from './safety.js';

export function commitEnvironment(email: string): NodeJS.ProcessEnv {
  if (!/^[1-9]\d*\+ClarkeYeh@users\.noreply\.github\.com$/.test(email))
    throw new Error('Expected ClarkeYeh noreply identity');
  // Do not inherit repository/index overrides, signing, injected config or ambient credentials.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.GH_CONFIG_DIR
      ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR }
      : {}),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'ClarkeYeh',
    GIT_COMMITTER_NAME: 'ClarkeYeh',
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
}
export type GitRunner = typeof git;
export async function verifyRemotes(
  path: string,
  run: GitRunner = git,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  for (const args of [
    ['remote', 'get-url', '--all', 'origin'],
    ['remote', 'get-url', '--push', '--all', 'origin'],
  ]) {
    const urls = (await run(args, path, env)).split('\n');
    if (urls.length !== 1)
      throw new Error('Exactly one origin and push URL required');
    assertRemote(urls[0]!);
  }
}
export class GitPusher {
  private sequence = 0;
  private constructor(
    readonly path: string,
    private readonly ledger: Ledger,
    private readonly env: NodeJS.ProcessEnv,
    private readonly run: GitRunner,
    private readonly authorize: () => Promise<void>,
    private readonly token: () => Promise<string>,
  ) {}
  static async create(
    ledger: Ledger,
    gate: { email: string; assertActive: () => Promise<void> },
    options: {
      run?: GitRunner;
      sourcePath?: string;
      token?: () => Promise<string>;
    } = {},
  ): Promise<GitPusher> {
    const run = options.run ?? git;
    await gate.assertActive();
    const env = commitEnvironment(gate.email);
    if (options.sourcePath) await verifyRemotes(options.sourcePath, run, env);
    const path = await mkdtemp(join(tmpdir(), 'aio-github-'));
    try {
      // Isolated clone, fixed destination, no user hooks or credential helper/config inheritance.
      await run(
        ['clone', '--no-checkout', `https://github.com/${REPO}.git`, path],
        tmpdir(),
        env,
      );
      return new GitPusher(
        path,
        ledger,
        env,
        run,
        gate.assertActive,
        options.token ?? (() => ghToken(false)),
      );
    } catch (e) {
      await rm(path, { recursive: true, force: true });
      throw e;
    }
  }
  async push({
    branch,
    base,
    itemKey = 'item',
  }: {
    branch: string;
    base: string;
    itemKey?: string;
  }): Promise<string> {
    assertBranch(branch, this.ledger.data.runId);
    await this.authorize();
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-zA-Z0-9_-]+$/.test(itemKey))
      throw new Error('Pusher requires a pinned base and safe item key');
    await verifyRemotes(this.path, this.run, this.env);
    const existing = await this.run(
      ['ls-remote', 'origin', `refs/heads/${branch}`],
      this.path,
      this.env,
    );
    if (
      existing &&
      !this.ledger.data.resources.some(
        (r) => r.kind === 'branch' && r.key === branch,
      )
    )
      throw new Error('Pusher cannot adopt an existing branch');
    const remote = await this.ledger.intent('branch', branch);
    await this.run(['fetch', 'origin', base], this.path, this.env);
    await this.run(['checkout', '--detach', base], this.path, this.env);
    const relative = `aio-test/${this.ledger.data.runId}/${itemKey}-${++this.sequence}.md`;
    await mkdir(join(this.path, 'aio-test', this.ledger.data.runId), {
      recursive: true,
    });
    await writeFile(
      join(this.path, relative),
      `# AI Office synthetic test\n\n${itemKey} ${this.sequence}\n`,
      { flag: 'wx' },
    );
    await this.run(['add', '--', relative], this.path, this.env);
    await this.run(
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        `AI Office synthetic ${itemKey} ${this.sequence}`,
      ],
      this.path,
      this.env,
    );
    const identity = await this.run(
      ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD'],
      this.path,
      this.env,
    );
    if (
      identity !==
      `ClarkeYeh\n${this.env.GIT_AUTHOR_EMAIL}\nClarkeYeh\n${this.env.GIT_COMMITTER_EMAIL}`
    )
      throw new Error('Commit identity verification failed');
    const changed = await this.run(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'],
      this.path,
      this.env,
    );
    if (changed !== relative)
      throw new Error('Commit includes unexpected files');
    await verifyRemotes(this.path, this.run, this.env);
    await this.run(
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'credential.helper=',
        'push',
        'origin',
        `HEAD:refs/heads/${branch}`,
      ],
      this.path,
      {
        ...this.env,
        // Keep the selected account's credential out of argv and disk. Never
        // consult gh's active-account credential helper for this push.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${await this.token()}`).toString('base64')}`,
      },
    );
    await this.ledger.created(remote);
    return this.run(['rev-parse', 'HEAD'], this.path, this.env);
  }
  async close(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }
}
