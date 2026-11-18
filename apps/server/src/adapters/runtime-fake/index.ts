import type { CommandResult } from '@ai-office/contracts/events';
import { PortError } from '../../ports/errors.js';
import {
  AgentRefSchema,
  SessionRefSchema,
  WorkspaceRefSchema,
  QuestionRefSchema,
  RuntimeCursorSchema,
} from '../../ports/refs.js';
import type {
  AgentRef,
  SessionRef,
  WorkspaceRef,
  RepoRuntimeRef,
  QuestionRef,
  RuntimeCursor,
} from '../../ports/refs.js';
import type { RuntimeEvent } from '../../ports/runtime-events.js';
import type { Clock } from '../../ports/services.js';
import type { RuntimePort, Correlation } from '../../ports/runtime.js';
import type {
  RuntimeScenario,
  RoleBehavior,
  ScenarioStep,
  ScenarioContext,
  SpawnRequest,
  Submitter,
  PushHandler,
} from './scenario.js';
export type * from './scenario.js';

export type FakeRuntimeOptions = {
  clock: Clock;
  scenario?: RuntimeScenario;
  submitter?: Submitter;
  onPush?: PushHandler;
  localRepos?: Readonly<
    Record<string, Awaited<ReturnType<RuntimePort['inspectLocalRepo']>>>
  >;
  /**
   * How an agent reads its spec (`Read the AI Office spec at <path> (sha256 <hex>)`
   * in the prompt). The text selects the scenario role and carries the seat token.
   */
  readSpec?: (path: string, sha256: string) => string | null;
  /**
   * What `git fetch` sees: the remote head of a branch, or the commit itself
   * when given a SHA that exists remotely; null when unknown.
   */
  remoteHead?: (ref: string) => Promise<string | null> | string | null;
  /** A transient submitter failure (backend down) is retried after this delay, like `ai-office submit` exit 2. */
  submitRetryMs?: number;
};
type Agent = {
  ref: AgentRef;
  session: SessionRef;
  workspace: WorkspaceRef;
  request: SpawnRequest;
  behavior: RoleBehavior;
  role: string;
  turn: number;
  generation: number;
  state: 'working' | 'waiting_input' | 'done' | 'stopped' | 'released' | 'lost';
  terminalHandle: string;
  paneKey: string;
  spec?: string;
};
type Scheduled = {
  at: number;
  order: number;
  agent: Agent;
  generation: number;
  action: ScenarioStep | { type: 'auto-release' } | { type: 'idle' };
  /** Turn scripts (spawn/send/answer) versus external `enqueue()` stimuli. */
  source: 'script' | 'external';
};
type EventBody = RuntimeEvent extends infer E
  ? E extends RuntimeEvent
    ? Omit<E, 'externalKey' | 'occurredAt'>
    : never
  : never;
type Delivery = Awaited<ReturnType<RuntimePort['observe']>>;
type Operation =
  | 'openSession'
  | 'reclaimSession'
  | 'prepareWorkspace'
  | 'spawnAgent'
  | 'send'
  | 'answer'
  | 'stop'
  | 'release'
  | 'observe'
  | 'closeSession'
  | 'disposeWorkspace'
  | 'findByCorrelation'
  | 'resolveCaller'
  | 'inspectLocalRepo'
  | 'inspectWorkspace';
/** Stable request comparison, independent of object property insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const fail = (code: string) =>
  new PortError('guard', code, `Fake runtime: ${code}`);

/** In-memory port simulator. Raw prompts/output stay transient; no files, processes or logging. */
export class FakeRuntime implements RuntimePort {
  private sequence = 0;
  private missingIdentity = false;
  private hijacked = new Set<SessionRef>();
  private checkTimeout = false;
  private loseCheckReceipt = false;
  private consumedChecks = new Map<SessionRef, number>();
  private holdNextSpawn = false;
  private pendingSpawns = new Map<
    AgentRef,
    { finish: () => void; completed: Promise<void>; events: RuntimeEvent[] }
  >();
  /** Fault controls are test-only; mailbox history remains available for backfill. */
  loseIdentity(): void {
    this.missingIdentity = true;
  }
  hijack(session: SessionRef): void {
    this.session(session);
    this.hijacked.add(session);
    this.emit(session, {
      type: 'runtime.identity_hijacked',
      run: session,
      coordinatorHandle: 'fake-other-coordinator',
      consumerGeneration: 2,
    });
  }
  timeoutCheck(): void {
    this.checkTimeout = true;
  }
  loseConsumedCheckReceipt(): void {
    this.loseCheckReceipt = true;
  }
  holdSpawn(): void {
    this.holdNextSpawn = true;
  }
  finishPendingSpawns(): void {
    for (const [ref, pending] of this.pendingSpawns) {
      this.pendingSpawns.delete(ref);
      this.session(this.agent(ref).session).push(...pending.events);
      pending.finish();
    }
  }
  private owned(session: SessionRef): void {
    if (this.hijacked.has(session))
      throw new PortError(
        'hijacked',
        'consumer_fenced',
        'Session belongs to another coordinator',
      );
  }
  private markers = new Map<string, CommandResult>();
  private pruned = new Set<string>();
  private workspaceNames = new Map<
    string,
    {
      commandId: string;
      prepared: Awaited<ReturnType<RuntimePort['prepareWorkspace']>>;
    }
  >();
  pruneReceipt(commandId: string): void {
    this.pruned.add(commandId);
  }
  async inspectRequest(
    _requestId: string,
    commandId: string,
  ): ReturnType<RuntimePort['inspectRequest']> {
    this.before('findByCorrelation');
    const result = this.markers.get(commandId);
    return result && !this.pruned.has(commandId)
      ? { status: 'completed', result: structuredClone(result) }
      : { status: 'absent' };
  }
  async findCommandByMarker(commandId: string): Promise<CommandResult | null> {
    this.before('findByCorrelation');
    return structuredClone(this.markers.get(commandId) ?? null);
  }
  async findWorkspace(
    req: Parameters<RuntimePort['findWorkspace']>[0],
  ): ReturnType<RuntimePort['findWorkspace']> {
    this.before('findByCorrelation');
    const found = this.workspaceNames.get(JSON.stringify([req.repo, req.name]));
    if (!found || !this.workspaces.has(found.prepared.workspace)) return null;
    if (found.commandId !== req.commandId)
      throw fail('workspace_comment_mismatch');
    return structuredClone(found.prepared);
  }
  private remoteBranches = new Map<
    string,
    { head: string; commits: Set<string> }
  >();
  private fetches: { repo: RepoRuntimeRef; branch: string; headSha: string }[] =
    [];
  /** Test wiring mirrors SCM changes without importing another adapter. */
  setRemoteBranch(repo: RepoRuntimeRef, branch: string, headSha: string): void {
    const key = JSON.stringify([repo.orcaRepoId, repo.localPath, branch]);
    const commits = this.remoteBranches.get(key)?.commits ?? new Set<string>();
    commits.add(headSha);
    this.remoteBranches.set(key, { head: headSha, commits });
  }
  fetchedBranches(): {
    repo: RepoRuntimeRef;
    branch: string;
    headSha: string;
  }[] {
    return structuredClone(this.fetches);
  }
  private workspaceBase(
    req: Parameters<RuntimePort['prepareWorkspace']>[0],
  ): string | undefined {
    if (req.checkoutExisting && req.fetchBranch !== req.branch)
      throw new PortError(
        'bug',
        'invalid_existing_branch',
        'Existing branch checkout requires fetchBranch to equal branch',
      );
    // An unpinned `origin/<fetchBranch>` base follows the freshly fetched head
    // (on-demand reviewers, integrate wrap-up); pinned bases must be known commits.
    if (
      req.baseSha === undefined &&
      req.fetchBranch !== undefined &&
      req.baseBranch === `origin/${req.fetchBranch}`
    ) {
      const remote = this.remoteBranches.get(
        JSON.stringify([
          req.repo.orcaRepoId,
          req.repo.localPath,
          req.fetchBranch,
        ]),
      );
      if (!remote) throw fail('remote_branch_not_found');
      this.fetches.push({
        repo: structuredClone(req.repo),
        branch: req.fetchBranch,
        headSha: remote.head,
      });
      return remote.head;
    }
    const baseSha =
      req.baseSha ?? (req.fetchBranch ? req.baseBranch : undefined);
    if (baseSha !== undefined || req.fetchBranch !== undefined) {
      if (
        !baseSha ||
        !req.fetchBranch ||
        req.baseBranch !== baseSha ||
        !/^[0-9a-f]{40}$/.test(baseSha)
      )
        throw new PortError(
          'bug',
          'invalid_workspace_base',
          'Pinned base requires fetchBranch and matching commit SHA',
        );
      const remote = this.remoteBranches.get(
        JSON.stringify([
          req.repo.orcaRepoId,
          req.repo.localPath,
          req.fetchBranch,
        ]),
      );
      if (!remote) throw fail('remote_branch_not_found');
      this.fetches.push({
        repo: structuredClone(req.repo),
        branch: req.fetchBranch,
        headSha: remote.head,
      });
      if (!remote.commits.has(baseSha)) throw fail('base_sha_unavailable');
      return baseSha;
    }
    return undefined;
  }
  private sessions = new Map<SessionRef, RuntimeEvent[]>();
  private agents = new Map<AgentRef, Agent>();
  private workspaces = new Map<
    WorkspaceRef,
    { clean: boolean; changedFiles: string[] }
  >();
  /** Branch and base commit each workspace was created with (pushes target it). */
  private workspaceBranches = new Map<
    WorkspaceRef,
    { branch: string; base?: string; repo?: RepoRuntimeRef }
  >();
  /** Simulated local git branches per repo (branch → tip); W1 occupancy derives from workspaces. */
  private localBranches = new Map<string, Map<string, string | undefined>>();
  private local(repo: RepoRuntimeRef): Map<string, string | undefined> {
    const key = JSON.stringify([repo.orcaRepoId, repo.localPath]);
    let branches = this.localBranches.get(key);
    if (!branches) this.localBranches.set(key, (branches = new Map()));
    return branches;
  }
  private holder(repo: RepoRuntimeRef, branch: string): WorkspaceRef | null {
    for (const [ws, entry] of this.workspaceBranches)
      if (
        this.workspaces.has(ws) &&
        entry.branch === branch &&
        entry.repo !== undefined &&
        canonical(entry.repo) === canonical(repo)
      )
        return ws;
    return null;
  }
  private remote(repo: RepoRuntimeRef, branch: string) {
    return this.remoteBranches.get(
      JSON.stringify([repo.orcaRepoId, repo.localPath, branch]),
    );
  }
  /**
   * Orca 1.4.259 `worktree create --branch` (P8): an unheld local branch whose
   * tip is the base is reused; any other taken name, including one that only
   * exists on the remote, silently gets a `-<n>` suffix.
   */
  private orcaCreateBranch(
    repo: RepoRuntimeRef,
    branch: string,
    base: string | undefined,
  ): string {
    const local = this.local(repo);
    const taken = (name: string) =>
      local.has(name) || this.remote(repo, name) !== undefined;
    if (
      local.has(branch) &&
      local.get(branch) === base &&
      !this.holder(repo, branch)
    )
      return branch;
    let name = branch;
    for (let n = 2; taken(name); n++) name = `${branch}-${n}`;
    local.set(name, base);
    return name;
  }
  /**
   * The adapter's W1 checks (§6.5): never ask git for a branch another worktree
   * holds; checkoutExisting points an unheld, fully pushed local branch at the
   * fetched sha first; a suffixed result is removed and refused.
   */
  private createWorktreeBranch(
    req: Parameters<RuntimePort['prepareWorkspace']>[0],
    base: string | undefined,
  ): void {
    if (this.holder(req.repo, req.branch)) throw fail('branch_in_use');
    const local = this.local(req.repo);
    if (req.checkoutExisting) {
      const tip = local.get(req.branch);
      if (
        tip !== undefined &&
        !this.remote(req.repo, req.branch)?.commits.has(tip)
      )
        throw fail('unpushed_commits');
      local.set(req.branch, base);
    }
    const actual = this.orcaCreateBranch(req.repo, req.branch, base);
    if (actual !== req.branch) {
      local.delete(actual);
      throw fail('branch_suffixed');
    }
  }
  /** `worktree rm`; the adapter also deletes the branch it created (§6.5). */
  private removeWorkspace(ws: WorkspaceRef): void {
    if (!this.workspaces.delete(ws)) return;
    const entry = this.workspaceBranches.get(ws);
    if (entry?.repo && !this.holder(entry.repo, entry.branch))
      this.local(entry.repo).delete(entry.branch);
  }
  /** The branch a workspace actually checked out, for W1 assertions. */
  workspaceBranch(ws: WorkspaceRef): string | null {
    return this.workspaces.has(ws)
      ? (this.workspaceBranches.get(ws)?.branch ?? null)
      : null;
  }
  private commands = new Map<
    string,
    { signature: string; result: unknown; session: SessionRef }
  >();
  private questions = new Map<QuestionRef, Agent>();
  private deliveries = new Map<string, Delivery>();
  private pendingDeliveries = new Map<string, Promise<Delivery>>();
  private cursors = new Map<
    RuntimeCursor,
    { session: SessionRef; offset: number }
  >();
  private scheduled: Scheduled[] = [];
  private faults: {
    operation: Operation;
    kind: 'disconnect' | 'response-lost';
  }[] = [];
  private connected = true;
  private pumping = false;
  private executing: Scheduled | undefined;
  constructor(private readonly options: FakeRuntimeOptions) {}
  /** JSON data only; behavior functions and spec credentials are reloaded locally. */
  snapshot() {
    const jobs = this.executing
      ? [this.executing, ...this.scheduled]
      : this.scheduled;
    return structuredClone({
      version: 1 as const,
      sequence: this.sequence,
      missingIdentity: this.missingIdentity,
      hijacked: [...this.hijacked],
      checkTimeout: this.checkTimeout,
      loseCheckReceipt: this.loseCheckReceipt,
      consumedChecks: [...this.consumedChecks],
      holdNextSpawn: this.holdNextSpawn,
      pendingSpawns: [...this.pendingSpawns].map(
        ([ref, pending]) => [ref, pending.events] as const,
      ),
      markers: [...this.markers],
      pruned: [...this.pruned],
      workspaceNames: [...this.workspaceNames],
      remoteBranches: [...this.remoteBranches].map(
        ([key, value]) =>
          [key, { head: value.head, commits: [...value.commits] }] as const,
      ),
      fetches: this.fetches,
      sessions: [...this.sessions],
      agents: [...this.agents.values()].map(({ behavior, spec, ...agent }) => {
        void behavior;
        void spec;
        return agent;
      }),
      workspaces: [...this.workspaces],
      workspaceBranches: [...this.workspaceBranches],
      localBranches: [...this.localBranches].map(
        ([repo, branches]) =>
          [
            repo,
            [...branches].map(
              ([branch, tip]) => [branch, tip ?? null] as const,
            ),
          ] as const,
      ),
      commands: [...this.commands],
      questions: [...this.questions].map(
        ([ref, agent]) => [ref, agent.ref] as const,
      ),
      deliveries: [...this.deliveries],
      cursors: [...this.cursors],
      scheduled: jobs.map(({ agent, ...job }) => ({
        ...job,
        agent: agent.ref,
      })),
      faults: this.faults,
      connected: this.connected,
    });
  }
  /** Restore into a fresh adapter wired to the same scenario and spec store. */
  restore(state: ReturnType<FakeRuntime['snapshot']>): void {
    if (state.version !== 1)
      throw new Error('Unsupported fake runtime snapshot version');
    if (this.pumping || this.pendingDeliveries.size || this.pendingSpawns.size)
      throw new Error('Cannot restore an active fake runtime');
    const data = structuredClone(state);
    this.sequence = data.sequence;
    this.missingIdentity = data.missingIdentity;
    this.hijacked = new Set(data.hijacked);
    this.checkTimeout = data.checkTimeout;
    this.loseCheckReceipt = data.loseCheckReceipt;
    this.consumedChecks = new Map(data.consumedChecks);
    this.holdNextSpawn = data.holdNextSpawn;
    this.markers = new Map(data.markers);
    this.pruned = new Set(data.pruned);
    this.workspaceNames = new Map(data.workspaceNames);
    this.remoteBranches = new Map(
      data.remoteBranches.map(([key, value]) => [
        key,
        { head: value.head, commits: new Set(value.commits) },
      ]),
    );
    this.fetches = data.fetches;
    this.sessions = new Map(data.sessions);
    this.agents = new Map(
      data.agents.map((agent) => {
        const spec = this.readSpec(agent.request.prompt);
        return [
          agent.ref,
          {
            ...agent,
            behavior: this.options.scenario?.roles[agent.role] ?? {},
            ...(spec === undefined ? {} : { spec }),
          },
        ];
      }),
    );
    // A held spawn's process-local promise is gone. Its external creation and
    // receipt survived; publish deferred events so reconciliation can finish it.
    for (const [ref, events] of data.pendingSpawns)
      this.session(this.agent(ref).session).push(...events);
    this.workspaces = new Map(data.workspaces);
    this.workspaceBranches = new Map(data.workspaceBranches);
    this.localBranches = new Map(
      data.localBranches.map(([repo, branches]) => [
        repo,
        new Map(branches.map(([branch, tip]) => [branch, tip ?? undefined])),
      ]),
    );
    this.commands = new Map(data.commands);
    this.questions = new Map(
      data.questions.map(([ref, agent]) => [ref, this.agent(agent)]),
    );
    this.deliveries = new Map(data.deliveries);
    this.cursors = new Map(data.cursors);
    this.scheduled = data.scheduled.map((job) => ({
      ...job,
      agent: this.agent(job.agent),
    }));
    this.faults = data.faults;
    this.connected = data.connected;
  }
  private id(prefix: string): string {
    return `fake-${prefix}-${++this.sequence}`;
  }
  private now(): number {
    return this.options.clock.now().getTime();
  }
  setConnected(connected: boolean): void {
    this.connected = connected;
  }
  injectFault(
    operation: Operation,
    kind: 'disconnect' | 'response-lost',
  ): void {
    this.faults.push({ operation, kind });
  }
  private before(operation: Operation): void {
    const i = this.faults.findIndex(
      (f) => f.operation === operation && f.kind === 'disconnect',
    );
    if (i >= 0) this.faults.splice(i, 1);
    if (!this.connected || i >= 0)
      throw new PortError(
        'transient',
        'runtime_unavailable',
        'Fake runtime disconnected',
        true,
      );
  }
  private after(operation: Operation): void {
    const i = this.faults.findIndex(
      (f) => f.operation === operation && f.kind === 'response-lost',
    );
    if (i >= 0) {
      this.faults.splice(i, 1);
      throw new PortError(
        'transient',
        'response_lost',
        'Fake response lost after success',
        true,
      );
    }
  }
  private command<T>(
    operation: Operation,
    correlation: Correlation,
    args: unknown,
    session: SessionRef | null,
    effect: () => T,
  ): T {
    this.before(operation);
    const signature = canonical({ operation, args });
    const previous = this.commands.get(correlation.commandId);
    if (previous) {
      if (previous.signature !== signature)
        throw new PortError(
          'bug',
          'request_mismatch',
          'Command ID reused with different parameters',
        );
      return structuredClone(previous.result) as T;
    }
    const result = effect();
    if (['openSession', 'spawnAgent', 'send', 'answer'].includes(operation)) {
      this.markers.set(correlation.commandId, {
        kind: 'runtime.' + operation,
        result:
          operation === 'openSession'
            ? { session: result }
            : operation === 'spawnAgent'
              ? { agent: result }
              : {},
      } as CommandResult);
    }
    this.commands.set(correlation.commandId, {
      signature,
      result: structuredClone(result),
      session: session ?? (result as SessionRef),
    });
    this.after(operation);
    return result;
  }
  private agent(ref: AgentRef): Agent {
    const agent = this.agents.get(ref);
    if (!agent) throw fail('unknown_agent');
    return agent;
  }
  private session(ref: SessionRef): RuntimeEvent[] {
    const events = this.sessions.get(ref);
    if (!events) throw fail('unknown_session');
    return events;
  }
  private live(agent: Agent): void {
    if (['released', 'stopped', 'lost'].includes(agent.state))
      throw fail('agent_not_live');
  }
  private emit(session: SessionRef, body: EventBody, at = this.now()): void {
    const event = {
      ...structuredClone(body),
      externalKey: this.id('event'),
      occurredAt: new Date(at).toISOString(),
    } as RuntimeEvent;
    const pending =
      'agent' in body ? this.pendingSpawns.get(body.agent) : undefined;
    if (pending) pending.events.push(event);
    else this.session(session).push(event);
  }
  private trigger(
    agent: Agent,
    trigger: 'spawn' | 'send' | 'answer',
    message?: ScenarioContext['message'],
  ): void {
    if (agent.behavior.silent) return;
    const script = agent.behavior[trigger];
    const context: ScenarioContext = {
      agent: agent.ref,
      session: agent.session,
      workspace: agent.workspace,
      request: structuredClone(agent.request),
      ...(agent.spec === undefined ? {} : { spec: agent.spec }),
      turn: agent.turn,
      ...(message ? { message } : {}),
    };
    const steps =
      typeof script === 'function' ? script(context) : (script ?? []);
    for (const action of steps) {
      const delay = action.afterMs ?? 0;
      if (!Number.isFinite(delay) || delay < 0)
        throw new PortError(
          'validation',
          'invalid_delay',
          'Scenario delay must be nonnegative and finite',
        );
      this.scheduled.push({
        at: this.now() + delay,
        order: ++this.sequence,
        agent,
        generation: agent.generation,
        action: structuredClone(action),
        source: 'script',
      });
    }
  }
  capabilities(): ReturnType<RuntimePort['capabilities']> {
    return {
      sharedWorkspace: true,
      exactBranchNaming: true,
      structuredTranscript: true,
      correlationSearch: true,
      callerChosenRequestId: true,
    };
  }
  async health(): ReturnType<RuntimePort['health']> {
    return {
      available: this.connected,
      version: 'fake',
      verified: true,
      shim: this.missingIdentity ? 'missing' : 'ready',
      ownership: this.hijacked.size
        ? 'hijacked'
        : this.sessions.size
          ? 'owned'
          : 'none',
    };
  }
  async openSession(
    req: Parameters<RuntimePort['openSession']>[0],
  ): Promise<SessionRef> {
    return this.command('openSession', req.correlation, req, null, () => {
      const ref = SessionRefSchema.parse(this.id('session'));
      this.sessions.set(ref, []);
      return ref;
    });
  }
  async reclaimSession(session: SessionRef): Promise<{ reclaimed: boolean }> {
    this.before('reclaimSession');
    this.session(session);
    this.hijacked.delete(session);
    this.after('reclaimSession');
    return { reclaimed: true };
  }
  async closeSession(session: SessionRef): Promise<void> {
    this.before('closeSession');
    this.session(session);
    this.after('closeSession'); /* Orca has no run deletion. */
  }
  async prepareWorkspace(
    req: Parameters<RuntimePort['prepareWorkspace']>[0],
  ): ReturnType<RuntimePort['prepareWorkspace']> {
    await this.fetchRemote(req);
    return this.command(
      'prepareWorkspace',
      req.correlation,
      req,
      req.session,
      () => {
        this.session(req.session);
        const key = JSON.stringify([req.repo, req.name]);
        const existing = this.workspaceNames.get(key);
        if (existing && this.workspaces.has(existing.prepared.workspace)) {
          if (existing.commandId !== req.correlation.commandId)
            throw fail('workspace_comment_mismatch');
          return structuredClone(existing.prepared);
        }
        const baseSha = this.workspaceBase(req);
        this.createWorktreeBranch(req, baseSha);
        const ref = WorkspaceRefSchema.parse(this.id('workspace'));
        this.workspaces.set(ref, { clean: true, changedFiles: [] });
        this.workspaceBranches.set(ref, {
          branch: req.branch,
          repo: structuredClone(req.repo),
          ...(baseSha === undefined ? {} : { base: baseSha }),
        });
        const prepared = {
          workspace: ref,
          path: `/fake-worktrees/${ref}`,
          ...(baseSha === undefined ? {} : { baseSha }),
        };
        this.workspaceNames.set(key, {
          commandId: req.correlation.commandId,
          prepared,
        });
        return prepared;
      },
    );
  }
  /** With `remoteHead`, mirror what a fetch would see: the branch head and the pinned commit. */
  private async fetchRemote(
    req: Parameters<RuntimePort['prepareWorkspace']>[0],
  ): Promise<void> {
    const remoteHead = this.options.remoteHead;
    if (remoteHead === undefined || req.fetchBranch === undefined) return;
    const pinned = req.baseSha ?? req.baseBranch;
    const [head, base] = await Promise.all([
      remoteHead(req.fetchBranch),
      /^[0-9a-f]{40}$/.test(pinned) ? remoteHead(pinned) : null,
    ]);
    if (base !== null) this.setRemoteBranch(req.repo, req.fetchBranch, base);
    if (head !== null) this.setRemoteBranch(req.repo, req.fetchBranch, head);
  }
  private readSpec(prompt: string): string | undefined {
    const match = /spec at (\S+) \(sha256 ([0-9a-f]{64})\)/.exec(prompt);
    if (!match || !this.options.readSpec) return undefined;
    return this.options.readSpec(match[1]!, match[2]!) ?? undefined;
  }
  async disposeWorkspace(ws: WorkspaceRef): Promise<void> {
    this.before('disposeWorkspace');
    this.removeWorkspace(ws);
    this.after('disposeWorkspace');
  }
  async spawnAgent(req: SpawnRequest): Promise<AgentRef> {
    this.owned(req.session);
    const result = this.command(
      'spawnAgent',
      req.correlation,
      req,
      req.session,
      () => {
        this.session(req.session);
        const workspace =
          req.workspace.kind === 'existing-worktree'
            ? req.workspace.workspace
            : WorkspaceRefSchema.parse(this.id('workspace'));
        if (
          req.workspace.kind === 'existing-worktree' &&
          !this.workspaces.has(workspace)
        )
          throw fail('unknown_workspace');
        if (!this.workspaces.has(workspace)) {
          this.workspaces.set(workspace, { clean: true, changedFiles: [] });
          if (req.workspace.kind === 'new-worktree')
            this.workspaceBranches.set(workspace, {
              branch: req.workspace.branch,
              base: req.workspace.baseBranch,
            });
        }
        const ref = AgentRefSchema.parse(this.id('agent'));
        const spec = this.readSpec(req.prompt);
        const role = this.options.scenario?.role?.(req, spec) ?? req.title;
        const agent: Agent = {
          ref,
          session: req.session,
          workspace,
          request: structuredClone(req),
          behavior: this.options.scenario?.roles[role] ?? {},
          role,
          turn: 1,
          generation: 0,
          state: 'working',
          terminalHandle: this.id('terminal'),
          paneKey: this.id('pane'),
          ...(spec === undefined ? {} : { spec }),
        };
        this.agents.set(ref, agent);
        if (this.holdNextSpawn) {
          this.holdNextSpawn = false;
          let finish!: () => void;
          const completed = new Promise<void>((resolve) => {
            finish = resolve;
          });
          this.pendingSpawns.set(ref, { finish, completed, events: [] });
        }
        this.emit(req.session, {
          type: 'agent.status',
          agent: ref,
          state: 'working',
        });
        this.trigger(agent, 'spawn');
        return ref;
      },
    );
    await this.pendingSpawns.get(result)?.completed;
    return result;
  }
  async send(
    ref: AgentRef,
    msg: Parameters<RuntimePort['send']>[1],
  ): Promise<void> {
    this.before('send');
    await this.runDue();
    const agent = this.agent(ref);
    this.owned(agent.session);
    this.command('send', msg.correlation, { ref, msg }, agent.session, () => {
      this.live(agent);
      agent.state = 'working';
      agent.turn++;
      agent.generation++;
      this.emit(agent.session, {
        type: 'agent.status',
        agent: ref,
        state: 'working',
      });
      this.trigger(agent, 'send', msg);
    });
  }
  async answer(
    question: QuestionRef,
    body: string,
    correlation: Correlation,
  ): Promise<void> {
    const agent = this.questions.get(question);
    if (!agent) throw fail('unknown_question');
    this.owned(agent.session);
    this.command(
      'answer',
      correlation,
      { question, body, correlation },
      agent.session,
      () => {
        this.live(agent);
        agent.state = 'working';
        this.emit(agent.session, {
          type: 'agent.status',
          agent: agent.ref,
          state: 'working',
        });
        this.trigger(agent, 'answer', { subject: String(question), body });
      },
    );
  }
  async stop(ref: AgentRef): Promise<void> {
    this.before('stop');
    const agent = this.agent(ref);
    if (
      !agent.behavior.ignoreStop &&
      !['released', 'stopped', 'lost'].includes(agent.state)
    ) {
      agent.state = 'stopped';
      agent.generation++;
      this.emit(agent.session, { type: 'agent.stopped', agent: ref });
    }
    this.after('stop');
  }
  async release(
    ref: AgentRef,
    opts: { removeWorkspace: boolean },
  ): Promise<void> {
    this.before('release');
    const agent = this.agent(ref);
    this.releaseAgent(agent, this.now());
    if (opts.removeWorkspace) this.removeWorkspace(agent.workspace);
    this.after('release');
  }
  private releaseAgent(agent: Agent, at: number): void {
    if (agent.state === 'released') return;
    agent.state = 'released';
    agent.generation++;
    this.emit(
      agent.session,
      { type: 'agent.exited', agent: agent.ref, reason: 'released' },
      at,
    );
  }
  /** Stable identity remains resolvable after release, for late submissions. */
  identity(ref: AgentRef): { terminalHandle: string; paneKey: string } {
    const a = this.agent(ref);
    return { terminalHandle: a.terminalHandle, paneKey: a.paneKey };
  }
  /** Queue external test stimuli through the same clock-driven scenario machinery. */
  enqueue(ref: AgentRef, ...steps: ScenarioStep[]): void {
    const agent = this.agent(ref);
    for (const action of steps) {
      const delay = action.afterMs ?? 0;
      if (!Number.isFinite(delay) || delay < 0)
        throw new PortError(
          'validation',
          'invalid_delay',
          'Scenario delay must be nonnegative and finite',
        );
      this.scheduled.push({
        at: this.now() + delay,
        order: ++this.sequence,
        agent,
        generation: agent.generation,
        action: structuredClone(action),
        source: 'external',
      });
    }
  }
  activeAgents(): AgentRef[] {
    return [...this.agents.values()]
      .filter((a) => ['working', 'waiting_input', 'done'].includes(a.state))
      .map((a) => a.ref);
  }
  async findByCorrelation(
    session: SessionRef,
    commandId: string,
  ): Promise<AgentRef | SessionRef | null> {
    this.before('findByCorrelation');
    this.after('findByCorrelation');
    this.session(session);
    const c = this.commands.get(commandId);
    if (!c || c.session !== session) return null;
    const result = c.result;
    return typeof result === 'string' &&
      (this.agents.has(result as AgentRef) ||
        this.sessions.has(result as SessionRef))
      ? (result as AgentRef | SessionRef)
      : null;
  }
  async resolveCaller(identity: {
    terminalHandle: string;
    paneKey?: string;
  }): Promise<AgentRef | null> {
    this.before('resolveCaller');
    this.after('resolveCaller');
    return (
      [...this.agents.values()].find(
        (a) =>
          a.terminalHandle === identity.terminalHandle &&
          (identity.paneKey === undefined || a.paneKey === identity.paneKey),
      )?.ref ?? null
    );
  }
  async inspectLocalRepo(
    localPath: string,
  ): ReturnType<RuntimePort['inspectLocalRepo']> {
    this.before('inspectLocalRepo');
    this.after('inspectLocalRepo');
    return structuredClone(
      this.options.localRepos?.[localPath] ?? {
        isGitMainWorktree: false,
        originUrl: null,
        runtimeRepoId: null,
      },
    );
  }
  setWorkspaceInspection(
    ws: WorkspaceRef,
    result: { clean: boolean; changedFiles: string[] },
  ): void {
    if (!this.workspaces.has(ws)) throw fail('unknown_workspace');
    this.workspaces.set(ws, structuredClone(result));
  }
  async inspectWorkspace(
    ws: WorkspaceRef,
  ): ReturnType<RuntimePort['inspectWorkspace']> {
    this.before('inspectWorkspace');
    this.after('inspectWorkspace');
    const value = this.workspaces.get(ws);
    if (!value) return { clean: false, changedFiles: [] };
    return structuredClone(value);
  }
  async observe(
    session: SessionRef,
    cursor: RuntimeCursor | null,
  ): Promise<Delivery> {
    this.before('observe');
    this.session(session);
    const key = JSON.stringify([session, cursor]);
    const prior = this.deliveries.get(key);
    if (prior) return structuredClone(prior);
    const position =
      cursor === null ? { session, offset: 0 } : this.cursors.get(cursor);
    if (!position || position.session !== session) throw fail('invalid_cursor');
    const pending = this.pendingDeliveries.get(key);
    if (pending) return structuredClone(await pending);
    const delivery = this.createDelivery(session, key, position.offset);
    this.pendingDeliveries.set(key, delivery);
    try {
      return structuredClone(await delivery);
    } finally {
      this.pendingDeliveries.delete(key);
    }
  }
  private async createDelivery(
    session: SessionRef,
    key: string,
    offset: number,
  ): Promise<Delivery> {
    if (this.checkTimeout) {
      this.checkTimeout = false;
      throw new PortError(
        'transient',
        'check_timeout',
        'Check timed out',
        true,
      );
    }
    if (this.missingIdentity) {
      this.missingIdentity = false;
      this.emit(session, {
        type: 'runtime.identity_restored',
        newShim: this.id('shim'),
        runs: [...this.sessions.keys()].filter(
          (run) => !this.hijacked.has(run),
        ),
      });
    }
    await this.runDue();
    const events = this.session(session);
    if (this.loseCheckReceipt) {
      this.loseCheckReceipt = false;
      this.consumedChecks.set(session, events.length);
      throw new PortError(
        'transient',
        'receipt_absent',
        'Consumed check receipt absent',
        true,
      );
    }
    // A consumed check cannot be replayed without its receipt. The durable inbox
    // history (sessions) still contains it, so backfill from the caller's cursor.
    const consumed = this.consumedChecks.get(session) ?? offset;
    const backfill = events.slice(offset, consumed);
    const unread = events.slice(Math.max(offset, consumed));
    this.consumedChecks.delete(session);
    const next = RuntimeCursorSchema.parse(this.id('cursor'));
    this.cursors.set(next, { session, offset: events.length });
    const result = {
      events: structuredClone([...backfill, ...unread]),
      cursor: next,
    };
    this.deliveries.set(key, result);
    this.after('observe');
    return structuredClone(result);
  }
  /** Advance the injected clock then await this pump. No background work or real sleeps. */
  async runDue(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        this.scheduled.sort((a, b) => a.at - b.at || a.order - b.order);
        const job = this.scheduled[0];
        if (!job || job.at > this.now()) return;
        this.scheduled.shift();
        if (
          job.generation !== job.agent.generation ||
          ['released', 'lost', 'stopped'].includes(job.agent.state)
        )
          continue;
        this.executing = job;
        try {
          await this.execute(job);
        } finally {
          this.executing = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private async execute({
    agent: a,
    action,
    at,
    order,
    source,
  }: Scheduled): Promise<void> {
    const emit = (body: EventBody) => this.emit(a.session, body, at);
    switch (action.type) {
      case 'submit': {
        const tokens = [
          ...new Set(
            `${a.request.prompt}\n${a.spec ?? ''}`.match(
              /\baio_seat_[A-Za-z0-9_-]+\b/g,
            ) ?? [],
          ),
        ];
        if (tokens.length !== 1 || !this.options.submitter)
          throw new PortError(
            'validation',
            'missing_submitter_or_token',
            'Submission requires a submitter and one unique seat token in the prompt or spec',
          );
        try {
          await this.options.submitter({
            agent: a.ref,
            ...this.identity(a.ref),
            seatToken: tokens[0]!,
            submission: structuredClone(action.submission),
          });
        } catch (error) {
          const retryMs = this.options.submitRetryMs;
          if (
            retryMs === undefined ||
            !(error instanceof PortError) ||
            error.category !== 'transient'
          )
            throw error;
          // The agent retries its `ai-office submit` once the backend is back.
          // The command blocks its turn: later steps (e.g. done) wait for it.
          // External stimuli (lost, degraded, unmanaged) are not part of the turn.
          const retryAt = this.now() + retryMs;
          for (const job of this.scheduled)
            if (
              job.agent === a &&
              job.source === 'script' &&
              job.generation === a.generation &&
              job.at < retryAt
            )
              job.at = retryAt;
          this.scheduled.push({
            at: retryAt,
            order,
            agent: a,
            generation: a.generation,
            action,
            source,
          });
        }
        break;
      }
      case 'push': {
        if (!this.options.onPush) throw fail('missing_push_handler');
        // A scenario's branch name is illustrative; agents push their own worktree.
        const own = this.workspaceBranches.get(a.workspace);
        if (own?.repo) {
          this.local(own.repo).set(own.branch, action.headSha);
          this.setRemoteBranch(own.repo, own.branch, action.headSha);
        }
        await this.options.onPush({
          agent: a.ref,
          workspace: a.workspace,
          branch: own?.branch ?? action.branch,
          headSha: action.headSha,
          ...(own?.base === undefined ? {} : { base: own.base }),
        });
        break;
      }
      case 'ask': {
        const question = QuestionRefSchema.parse(this.id('question'));
        this.questions.set(question, a);
        a.state = 'waiting_input';
        emit({
          type: 'agent.question',
          agent: a.ref,
          question,
          body: action.body,
        });
        emit({
          type: 'agent.status',
          agent: a.ref,
          state: 'waiting_input',
          waitingSince: new Date(at).toISOString(),
        });
        break;
      }
      case 'done':
        a.state = 'done';
        emit({
          type: 'agent.done',
          agent: a.ref,
          outcome: action.outcome ?? 'success',
          ...(action.filesModified === undefined
            ? {}
            : { filesModified: action.filesModified }),
        });
        if (action.idleAfterMs !== undefined)
          this.scheduled.push({
            at: at + action.idleAfterMs,
            order: ++this.sequence,
            agent: a,
            generation: a.generation,
            action: { type: 'idle' },
            source: 'script',
          });
        if (!a.request.keepOpen)
          this.scheduled.push({
            at: at + 120_000,
            order: ++this.sequence,
            agent: a,
            generation: a.generation,
            action: { type: 'auto-release' },
            source: 'script',
          });
        break;
      case 'auto-release':
        this.releaseAgent(a, at);
        break;
      case 'idle':
        emit({ type: 'agent.status', agent: a.ref, state: 'idle' });
        break;
      case 'rate-limited':
        emit({
          type: 'agent.rate_limited',
          agent: a.ref,
          evidence: action.evidence,
          ...(action.resetsAt === undefined
            ? {}
            : { resetsAt: action.resetsAt }),
        });
        break;
      case 'lost':
        a.state = 'lost';
        a.generation++;
        emit({ type: 'agent.status', agent: a.ref, state: 'lost' });
        break;
      case 'degraded':
        emit({ type: 'agent.degraded', agent: a.ref, reason: action.reason });
        break;
      case 'unmanaged':
        emit({
          type: 'agent.unmanaged',
          dispatch: action.dispatch,
          parentDispatch: a.ref,
        });
        break;
      case 'output':
        emit({
          type: 'agent.output',
          agent: a.ref,
          messageId: this.id('message'),
          role: 'assistant',
          blocks: action.blocks,
        });
        break;
      case 'policy':
        emit({
          type: 'agent.output',
          agent: a.ref,
          messageId: this.id('message'),
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              id: this.id('tool'),
              name: 'shell',
              input: { command: action.command },
            },
          ],
        });
        break;
      case 'duplicate': {
        const events = this.session(a.session);
        const last = events.at(-1);
        if (last) events.push(structuredClone(last));
        break;
      }
      // These are filtered Orca artifacts, not domain failures (M0.5 / Q6).
      case 'false-escalation':
      case 'turn-start-unobserved':
        break;
    }
  }
}
export const createFakeRuntime = (options: FakeRuntimeOptions): FakeRuntime =>
  new FakeRuntime(options);
