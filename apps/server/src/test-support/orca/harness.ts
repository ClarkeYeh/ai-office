import { acquireOrcaLiveLock } from './lock.js';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  Exec,
  ExecRequest,
  ExecResult,
} from '../../adapters/runtime-orca/cli/types.js';
import { subprocessEnv } from '../../adapters/runtime-orca/env-allowlist.js';
import { shimMarker } from '../../adapters/runtime-orca/coordinator-identity/shim.js';
import { scanResources, assertScanClean, type ScanResource } from './scan.js';
import { assertCommand } from './command-gate.js';
import {
  assertOutside,
  assertTestRepo,
  claimedBranch,
  claimedWorktree,
  NAMESPACE_ID,
  TEST_REPO_URL,
  testBranch,
  testWorktree,
} from './safety.js';
import {
  claims,
  cleanup,
  leftovers,
  emptyLedger,
  saveLedger,
  type ResourceLedger,
} from './ledger.js';

/** Bounded, shell-free subprocess boundary. Never expose output in exceptions. */
export class HarnessExec implements Exec {
  async run(request: ExecRequest): Promise<ExecResult> {
    if (request.signal?.aborted) throw new Error('Harness command aborted');
    return new Promise((resolve, reject) => {
      const child = spawn(request.bin, request.args, {
        cwd: request.cwd,
        env: subprocessEnv(request.env, []),
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let data = '';
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(fail, request.timeoutMs);
      request.signal?.addEventListener('abort', fail, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (data.length + chunk.length > 16 * 1024 * 1024) fail();
        else data += chunk.toString();
      });
      child.on('error', () => {
        failed = true;
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', fail);
        if (failed)
          reject(new Error('Harness command failed or exceeded limits'));
        else resolve({ stdout: data, exitCode });
      });
    });
  }
}
/**
 * Orca 1.4.259 request_mismatch details: exactly the reused request id (ours) and
 * the original argv. Any other key may describe residual resources: stay pending.
 */
function mismatchData(data: unknown, args: readonly string[]): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data).sort();
  const { orchestrationRequestId: id, originalCommand } = data as Record<
    string,
    unknown
  >;
  const requestIndex = args.indexOf('--retry-request');
  return (
    keys.length === 2 &&
    keys[0] === 'orchestrationRequestId' &&
    keys[1] === 'originalCommand' &&
    requestIndex >= 0 &&
    id === args[requestIndex + 1] &&
    Array.isArray(originalCommand) &&
    originalCommand.every((arg) => typeof arg === 'string')
  );
}
/** Ledger hooks for resources a composed backend creates itself. */
export interface ComposedEffects {
  /** `aio-shim:<hash>` in the backend's shim title; scanned after cleanup. */
  readonly marker: string;
  shim(handle: string): Promise<void>;
  /** Clears the startup intent once the backend has reported its shim. */
  settle(): Promise<void>;
}
export interface HarnessOptions {
  repoPath: string;
  repoUrl?: string;
  sourceRoot: string;
  orcaBin: string;
  /** Refreshed before every command; must enumerate all Orca worktree roots. */
  worktreePaths: () => Promise<string[]>;
  exec?: Exec;
  agents?: boolean;
  env?: NodeJS.ProcessEnv;
  ledger?: ResourceLedger;
}
export class OrcaHarness {
  readonly ledger: ResourceLedger;
  readonly ledgerPath: string;
  private readonly exec: Exec;
  private cleaning: Promise<void> | undefined;
  private controller = new AbortController();
  private interrupted = false;
  private releaseLiveLock: (() => Promise<void>) | undefined;
  private constructor(
    private readonly options: HarnessOptions,
    dataDir: string,
  ) {
    this.ledger =
      options.ledger ??
      emptyLedger(options.repoPath, options.repoUrl ?? TEST_REPO_URL, dataDir);
    this.ledgerPath = join(dataDir, 'resources.json');
    this.exec = options.exec ?? new HarnessExec();
  }
  static async create(options: HarnessOptions): Promise<OrcaHarness> {
    const env = options.env ?? process.env;
    if (
      env.CI ||
      env.AIO_REAL_ORCA !== '1' ||
      (options.agents && env.AIO_REAL_AGENTS !== '1')
    )
      throw new Error('Real Orca opt-in required');
    if (!isAbsolute(options.orcaBin))
      throw new Error('Absolute Orca binary required');
    if (!env.HOME || !isAbsolute(env.HOME))
      throw new Error('Absolute HOME required for Orca live lock');
    const release = await acquireOrcaLiveLock(
      join(env.HOME, '.ai-office', 'test-state', 'orca-live.lock'),
    );
    try {
      const dataDir =
        options.ledger?.dataDir ?? (await mkdtemp(join(tmpdir(), 'aio-test-')));
      await mkdir(join(dataDir, 'cli-cwd'), { recursive: true, mode: 0o700 });
      const harness = new OrcaHarness(options, dataDir);
      harness.releaseLiveLock = release;
      await harness.verify();
      await harness.persist();
      return harness;
    } catch (error) {
      await release();
      throw error;
    }
  }
  private async execute(
    bin: string,
    args: readonly string[],
  ): Promise<ExecResult> {
    return this.exec.run({
      bin,
      args,
      cwd: join(this.ledger.dataDir, 'cli-cwd'),
      env: this.options.env ?? process.env,
      timeoutMs: 60_000,
      signal: this.controller.signal,
    });
  }
  private async verify(): Promise<void> {
    if (this.ledger.repoPath !== this.options.repoPath)
      throw new Error('Ledger repository differs from configured clone');
    const roots = [
      this.options.sourceRoot,
      this.ledger.repoPath,
      ...(await this.options.worktreePaths()),
    ];
    await assertOutside(this.ledger.dataDir, roots);
    await assertOutside(join(this.ledger.dataDir, 'cli-cwd'), roots);
    await assertTestRepo(
      {
        originUrl: async (repo) => {
          const result = await this.execute('git', [
            '-C',
            repo,
            'remote',
            'get-url',
            'origin',
          ]);
          if (result.exitCode !== 0)
            throw new Error('Cannot verify test origin');
          return result.stdout.trim();
        },
      },
      this.ledger.repoPath,
      this.ledger.repoUrl,
    );
  }
  persist(): Promise<void> {
    return saveLedger(this.ledgerPath, this.ledger);
  }
  async command(
    args: readonly string[],
    expectedRejection?: 'request_mismatch',
  ): Promise<Record<string, unknown>> {
    if (
      this.interrupted &&
      !['worker-stop', 'worker-release', 'rm', 'close', 'task-update'].includes(
        args[1] ?? '',
      )
    )
      throw new Error('Harness interrupted');
    assertCommand(args, this.ledger, this.options.agents ?? false);
    await this.verify();
    const requestIndex = args.indexOf('--retry-request');
    if (requestIndex >= 0) {
      const id = args[requestIndex + 1]!;
      if (!this.ledger.requests.includes(id)) {
        this.ledger.requests.push(id);
        await this.persist();
      }
    }
    const mutation = ['run-create', 'worker-start', 'send'].includes(
      args[1] ?? '',
    )
      ? await this.beginMutation(args[1]!)
      : undefined;
    const result = await this.receipt(
      args,
      async (result) => {
        if (
          ['inbox', 'check'].includes(args[1] ?? '') &&
          Array.isArray(result.messages)
        ) {
          for (const message of result.messages) {
            const id = (message as { id?: unknown }).id;
            if (typeof id === 'string' && !this.ledger.messages.includes(id))
              this.ledger.messages.push(id);
          }
          await this.persist();
        }
        if (args[1] === 'run-create') {
          const run = result.run as { id?: string } | undefined;
          if (!run?.id) throw new Error('Missing run receipt');
          if (!this.ledger.runs.includes(run.id)) this.ledger.runs.push(run.id);
          await this.persist();
        }
        if (['worker-start', 'send'].includes(args[1] ?? '')) {
          if (
            typeof result.dispatchId === 'string' &&
            !this.ledger.dispatches.some((d) => d.id === result.dispatchId)
          )
            this.ledger.dispatches.push({
              id: result.dispatchId,
              stopped: false,
              done: false,
            });
          if (
            typeof result.taskId === 'string' &&
            !this.ledger.tasks.some((t) => t.id === result.taskId)
          )
            this.ledger.tasks.push({ id: result.taskId, done: false });
          await this.persist();
        }
        if (
          mutation &&
          !expectedRejection &&
          (typeof result.dispatchId === 'string' ||
            typeof (result.run as { id?: unknown } | undefined)?.id ===
              'string')
        )
          await this.endMutation(mutation);
      },
      expectedRejection
        ? async (code) => {
            if (mutation) await this.endMutation(mutation);
            return { rejected: code };
          }
        : undefined,
    );
    if (expectedRejection && result.rejected !== expectedRejection)
      throw new Error('Expected explicit request rejection');
    return result;
  }
  private async beginMutation(kind: string): Promise<string> {
    if (this.interrupted) throw new Error('Harness interrupted');
    const id = randomUUID();
    this.ledger.pending.push({ id, kind });
    await this.persist();
    return id;
  }
  private async endMutation(id: string): Promise<void> {
    this.ledger.pending = this.ledger.pending.filter((p) => p.id !== id);
    await this.persist();
  }
  private async receipt(
    args: readonly string[],
    capture?: (result: Record<string, unknown>) => Promise<void>,
    rejected?: (code: 'request_mismatch') => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const output = await this.execute(this.options.orcaBin, args);
    let parsed: {
      ok?: boolean;
      result?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(output.stdout) as typeof parsed;
    } catch {
      throw new Error('Invalid Orca receipt');
    }
    // Only a known pre-execution rejection with no resource/result details can
    // discharge the intent. Malformed, unknown, or residual-resource receipts
    // remain pending for reconciliation; never infer this from the exit code.
    if (
      rejected &&
      parsed.ok === false &&
      Object.keys(parsed).every((key) =>
        ['ok', 'id', 'error', 'result', '_meta'].includes(key),
      ) &&
      parsed.error?.code === 'request_mismatch' &&
      Object.keys(parsed.error).every((key) =>
        ['code', 'message', 'data'].includes(key),
      ) &&
      (parsed.error.data === undefined ||
        mismatchData(parsed.error.data, args)) &&
      (parsed.result == null ||
        (typeof parsed.result === 'object' &&
          !Array.isArray(parsed.result) &&
          Object.keys(parsed.result).length === 0))
    )
      return rejected('request_mismatch');
    if (parsed.result && typeof parsed.result === 'object')
      await capture?.(parsed.result);
    if (!parsed.ok || !parsed.result) throw new Error('Orca receipt rejected');
    // Nonzero exit with ok:true is a receipt, not permission to retry a mutation.
    return parsed.result;
  }
  async createWorktree(
    name: string,
    branch: string,
    sha: string,
  ): Promise<void> {
    testWorktree(name, `aio:${name}`);
    testBranch(branch);
    if (!/^[a-f0-9]{40}$/.test(sha))
      throw new Error('Fetched commit SHA required');
    await this.verify();
    // Refuse pre-existing local or remote names rather than claim somebody else's branch.
    for (const args of [
      ['show-ref', '--quiet', '--verify', `refs/heads/${branch}`],
      ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`],
    ]) {
      const result = await this.execute('git', [
        '-C',
        this.ledger.repoPath,
        ...args,
      ]);
      if (result.exitCode !== (args[0] === 'show-ref' ? 1 : 2))
        throw new Error('Test branch already exists or lookup failed');
    }
    const intent = await this.beginMutation('worktree-create');
    this.ledger.localBranches.push({ id: branch, done: false });
    await this.persist();
    const created = await this.execute('git', [
      '-C',
      this.ledger.repoPath,
      'branch',
      branch,
      sha,
    ]);
    if (created.exitCode !== 0) throw new Error('Cannot create test branch');
    const result = await this.receipt(
      [
        'worktree',
        'create',
        '--repo',
        `path:${this.ledger.repoPath}`,
        '--name',
        name,
        '--branch',
        branch,
        '--base-branch',
        sha,
        '--no-parent',
        '--setup',
        'skip',
        '--comment',
        `aio:${name}`,
        '--json',
      ],
      async (receipt) => {
        const created = receipt.worktree as
          { id?: unknown; branch?: unknown } | undefined;
        if (typeof created?.id !== 'string' || !created.id) return;
        // The returned ID proves creation; preserve the requested ownership marker
        // even when the remaining receipt metadata is malformed.
        this.ledger.worktrees.push({
          id: created.id,
          branch,
          name,
          comment: `aio:${name}`,
          done: false,
        });
        if (typeof created.branch === 'string') {
          const actual = created.branch.replace(/^refs\/heads\//, '');
          try {
            testBranch(actual);
            if (!this.ledger.localBranches.some((b) => b.id === actual))
              this.ledger.localBranches.push({ id: actual, done: false });
          } catch {
            /* Never claim or delete a non-test branch. */
          }
        }
        await this.endMutation(intent);
      },
    );
    const w = result.worktree as
      | { id?: string; branch?: string; displayName?: string; comment?: string }
      | undefined;
    if (
      !w?.id ||
      w.branch?.replace(/^refs\/heads\//, '') !== branch ||
      w.displayName !== name ||
      w.comment !== `aio:${name}`
    )
      throw new Error(
        'Unexpected worktree receipt; inspect test resources before retry',
      );
  }
  async createShim(folderPath: string): Promise<string> {
    // Only the previously owner-approved folder registration is usable; never register it here.
    const home = (this.options.env ?? process.env).HOME;
    if (!home || folderPath !== join(home, '.ai-office', 'orca-home'))
      throw new Error('Approved shim folder required');
    await this.verify();
    const intent = await this.beginMutation('shim-create');
    const result = await this.receipt(
      [
        'terminal',
        'create',
        '--worktree',
        `path:${folderPath}`,
        '--title',
        'aio-test-shim',
        '--command',
        'exec cat > /dev/null',
        '--json',
      ],
      async (receipt) => {
        const created = receipt.terminal as { handle?: unknown } | undefined;
        if (typeof created?.handle !== 'string' || !created.handle) return;
        this.ledger.shims.push({ id: created.handle, done: false });
        await this.endMutation(intent);
      },
    );
    const terminal = result.terminal as { handle?: string } | undefined;
    if (!terminal?.handle) throw new Error('Missing shim receipt');
    return terminal.handle;
  }
  /**
   * Journals a composed backend before it starts: its shim marker joins the scan
   * and an intent stays pending until `settle`. Reported shims are ledgered
   * (and persisted) before the backend uses them. A backend that never
   * reports a shim leaves the intent pending for reconciliation.
   */
  async composedBackend(backendDataDir: string): Promise<ComposedEffects> {
    await this.verify();
    await assertOutside(backendDataDir, [
      this.options.sourceRoot,
      this.ledger.repoPath,
      ...(await this.options.worktreePaths()),
    ]);
    const marker = shimMarker(backendDataDir);
    if (!this.ledger.shimMarkers.includes(marker))
      this.ledger.shimMarkers.push(marker);
    const intent = await this.beginMutation('composed-backend');
    let shims = 0;
    return {
      marker,
      shim: async (handle) => {
        if (!/^term_[A-Za-z0-9-]+$/.test(handle))
          throw new Error('Unexpected composed shim handle');
        if (!this.ledger.shims.some((s) => s.id === handle))
          this.ledger.shims.push({ id: handle, done: false });
        shims++;
        await this.persist();
      },
      settle: async () => {
        if (!shims)
          throw new Error(
            'Composed backend reported no shim; reconcile private ledger',
          );
        await this.endMutation(intent);
      },
    };
  }
  /**
   * T17: journals a namespace intent BEFORE a scenario starts a workflow on its
   * isolated composed backend; the returned `bind` records that workflow's
   * shortId. Until bound the intent stays pending, which blocks destructive
   * cleanup (reconcile with the janitor). A claim covers exactly
   * `ai-office/<id>/*`, `ai-office/<id>-*` and `aio-<id>-*`.
   */
  async claimWorkflowNamespace(): Promise<(shortId: string) => Promise<void>> {
    const intent = await this.beginMutation('workflow-namespace');
    return async (shortId) => {
      if (!NAMESPACE_ID.test(shortId))
        throw new Error('Invalid workflow namespace');
      if (!this.ledger.namespaces.some((n) => n.id === shortId))
        this.ledger.namespaces.push({ id: shortId, done: false });
      await this.persist();
      await this.endMutation(intent);
    };
  }
  /** Adopts a composed backend's run, only if its coordinator is a ledgered shim. */
  async adoptBackendRun(run: string): Promise<void> {
    if (!/^run_[A-Za-z0-9]+$/.test(run)) throw new Error('Invalid run id');
    if (this.ledger.runs.includes(run)) return;
    await this.verify();
    const shown = await this.read(['orchestration', 'run-show', '--id', run]);
    const handle = (shown.run as { coordinator_handle?: unknown } | undefined)
      ?.coordinator_handle;
    if (
      typeof handle !== 'string' ||
      !this.ledger.shims.some((s) => s.id === handle)
    )
      throw new Error('Run is not coordinated by a ledgered shim');
    this.ledger.runs.push(run);
    await this.persist();
  }
  /** Read-only (level A) Orca receipt outside the mutation gate. */
  private async read(args: string[]): Promise<Record<string, unknown>> {
    const output = await this.execute(this.options.orcaBin, [
      ...args,
      '--json',
      ...(args[0] === 'orchestration' ? ['--full'] : []),
    ]);
    const parsed = JSON.parse(output.stdout) as {
      ok?: boolean;
      result?: Record<string, unknown>;
    };
    if (!parsed.ok || !parsed.result) throw new Error('Orca read rejected');
    return parsed.result;
  }
  /**
   * Ledgers what the composed backend left in claimed namespaces: live
   * dispatches of adopted runs, `aio-<id>-*` worktrees and claimed branches.
   */
  private async adoptClaimed(): Promise<void> {
    const namespaces = claims(this.ledger);
    if (!this.ledger.namespaces.some((n) => !n.done)) return;
    await this.verify();
    for (const run of this.ledger.runs) {
      const { workers } = await this.read([
        'orchestration',
        'worker-list',
        '--run',
        run,
      ]);
      if (!Array.isArray(workers)) throw new Error('Invalid worker inventory');
      for (const w of workers as Record<string, unknown>[]) {
        if (
          typeof w.dispatchId !== 'string' ||
          // Only rows that still own a terminal: follow-up dispatches whose
          // terminal moved on (terminalState null) have nothing to stop.
          w.terminalState == null ||
          w.terminalState === 'released' ||
          this.ledger.dispatches.some((d) => d.id === w.dispatchId)
        )
          continue;
        this.ledger.dispatches.push({
          id: w.dispatchId,
          stopped: false,
          done: false,
        });
      }
    }
    const { worktrees } = await this.read([
      'worktree',
      'list',
      '--repo',
      `path:${this.ledger.repoPath}`,
      '--limit',
      '100000',
    ]);
    if (!Array.isArray(worktrees))
      throw new Error('Invalid worktree inventory');
    for (const w of worktrees as Record<string, unknown>[]) {
      const name = w.displayName ?? w.name;
      if (typeof name !== 'string' || !claimedWorktree(name, namespaces))
        continue;
      const branch = String(w.branch ?? '').replace(/^refs\/heads\//, '');
      const comment = String(w.comment ?? '');
      if (typeof w.id !== 'string') throw new Error('Worktree missing ID');
      // Fail closed: a claimed name must also carry a claimed branch and marker.
      testWorktree(name, comment, namespaces);
      // M3-T17: an agent may leave its worktree on a detached HEAD (Orca
      // reports branch null); the claimed name and aio: marker still prove
      // ownership, and a branch it does name must be claimed.
      if (branch !== '' && !claimedBranch(branch, namespaces))
        throw new Error('Claimed worktree on an unclaimed branch');
      if (!this.ledger.worktrees.some((x) => x.id === w.id))
        this.ledger.worktrees.push({
          id: w.id,
          name,
          comment,
          branch,
          done: false,
        });
    }
    for (const r of await this.scan()) {
      if (r.kind !== 'localBranch' && r.kind !== 'remoteBranch') continue;
      if (!claimedBranch(r.id, namespaces)) continue;
      const list =
        r.kind === 'localBranch'
          ? this.ledger.localBranches
          : this.ledger.remoteBranches;
      const existing = list.find((b) => b.id === r.id);
      if (existing) existing.done = false;
      else list.push({ id: r.id, done: false });
    }
    await this.persist();
  }
  async createRun(shim: string, name: string): Promise<string> {
    const result = await this.command([
      'orchestration',
      'run-create',
      '--from',
      shim,
      '--objective',
      `aio-test-${name}`,
      '--retry-request',
      randomUUID(),
      '--json',
      '--full',
    ]);
    const run = result.run as { id?: string } | undefined;
    if (!run?.id) throw new Error('Missing run receipt');
    await this.persist();
    return run.id;
  }
  async collectUsage(
    read: () => Promise<ResourceLedger['usage']>,
  ): Promise<void> {
    const usage = await read();
    this.ledger.usage.push(...usage);
    await this.persist();
  }
  async scan(): Promise<ScanResource[]> {
    const home = (this.options.env ?? process.env).HOME;
    if (!home) throw new Error('Home required for scoped shim inventory');
    return scanResources(
      this.ledger.repoPath,
      join(home, '.ai-office', 'orca-home'),
      async (kind, args) => {
        await this.verify();
        return this.execute(
          kind === 'orca' ? this.options.orcaBin : 'git',
          args,
        );
      },
      this.ledger.shimMarkers,
      claims(this.ledger),
    );
  }
  async assertClean(): Promise<void> {
    if (leftovers(this.ledger).length)
      throw new Error('Ledger resources remain after cleanup');
    await assertScanClean(() => this.scan());
  }
  /** Release only after the caller has completed its final scan. */
  async close(): Promise<void> {
    const release = this.releaseLiveLock;
    this.releaseLiveLock = undefined;
    await release?.();
  }
  async clean(): Promise<void> {
    this.cleaning ??= this.cleanupResources().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }
  private async cleanupResources(): Promise<void> {
    if (this.ledger.pending.length)
      throw new Error(
        'Unresolved mutation receipt: reconcile private ledger before cleanup',
      );
    await this.adoptClaimed();
    const command = async (args: string[]) => {
      await this.command([
        ...args,
        '--json',
        ...(args[0] === 'orchestration' ? ['--full'] : []),
      ]);
    };
    await cleanup(
      this.ledger,
      {
        stop: async (id) => {
          const result = await this.command([
            'orchestration',
            'worker-stop',
            '--dispatch',
            id,
            '--json',
            '--full',
          ]);
          if (
            result.alreadySettled !== true &&
            ![
              'stopped',
              'failed',
              'succeeded',
              'cancelled',
              'completed',
              'released',
            ].includes(String(result.state))
          )
            throw new Error('Worker stop has not settled');
        },
        release: async (id) => {
          const result = await this.command([
            'orchestration',
            'worker-release',
            '--dispatch',
            id,
            '--json',
            '--full',
          ]);
          if (!['released', 'already_released'].includes(String(result.state)))
            throw new Error('Worker release has not settled');
        },
        removeWorktree: (id) =>
          command(['worktree', 'rm', '--worktree', `id:${id}`]),
        closeShim: (id) => command(['terminal', 'close', '--terminal', id]),
        deleteRemote: (id) => this.deleteBranch(id, true),
        deleteLocal: (id) => this.deleteBranch(id, false),
        failTask: (id) =>
          command([
            'orchestration',
            'task-update',
            '--id',
            id,
            '--status',
            'failed',
            '--run',
            this.ledger.runs[0] ?? '',
            '--from',
            this.ledger.shims[0]?.id ?? '',
          ]),
      },
      () => this.persist(),
    );
    // Every claimed resource was adopted above and is now cleaned.
    for (const n of this.ledger.namespaces) n.done = true;
    await this.persist();
  }
  private async deleteBranch(branch: string, remote: boolean): Promise<void> {
    testBranch(branch, !remote, claims(this.ledger));
    await this.verify();
    const args = remote
      ? ['push', 'origin', '--delete', branch]
      : ['branch', '-D', branch];
    const result = await this.execute('git', [
      '-C',
      this.ledger.repoPath,
      ...args,
    ]);
    if (result.exitCode !== 0) {
      const probe = await this.execute('git', [
        '-C',
        this.ledger.repoPath,
        ...(remote
          ? ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]
          : ['show-ref', '--quiet', '--verify', `refs/heads/${branch}`]),
      ]);
      if (probe.exitCode !== (remote ? 2 : 1))
        throw new Error('Test branch cleanup failed');
    }
  }
  /** Register with afterAll; SIGINT also attempts cleanup, retaining failed entries for janitor. */
  installCleanup(
    afterAll: (fn: () => Promise<void>) => void,
    closeAfterCleanup = true,
  ): void {
    const finish = async () => {
      try {
        await this.clean();
        if (closeAfterCleanup) await this.assertClean();
      } finally {
        if (closeAfterCleanup) await this.close();
      }
    };
    const interrupt = () => {
      this.interrupted = true;
      this.controller.abort();
      this.controller = new AbortController();
      void finish().then(
        () => {
          process.exitCode = 130;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', interrupt);
    afterAll(async () => {
      try {
        await finish();
      } finally {
        process.removeListener('SIGINT', interrupt);
      }
    });
  }
}
