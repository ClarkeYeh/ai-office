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
};
type Agent = {
  ref: AgentRef;
  session: SessionRef;
  workspace: WorkspaceRef;
  request: SpawnRequest;
  behavior: RoleBehavior;
  turn: number;
  generation: number;
  state: 'working' | 'waiting_input' | 'done' | 'stopped' | 'released' | 'lost';
  terminalHandle: string;
  paneKey: string;
};
type Scheduled = {
  at: number;
  order: number;
  agent: Agent;
  generation: number;
  action: ScenarioStep | { type: 'auto-release' };
};
type EventBody = RuntimeEvent extends infer E
  ? E extends RuntimeEvent
    ? Omit<E, 'externalKey' | 'occurredAt'>
    : never
  : never;
type Delivery = Awaited<ReturnType<RuntimePort['observe']>>;
type Operation =
  | 'openSession'
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
  constructor(private readonly options: FakeRuntimeOptions) {}
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
    this.session(session).push({
      ...structuredClone(body),
      externalKey: this.id('event'),
      occurredAt: new Date(at).toISOString(),
    } as RuntimeEvent);
  }
  private trigger(
    agent: Agent,
    trigger: 'spawn' | 'send' | 'answer',
    message?: ScenarioContext['message'],
  ): void {
    const script = agent.behavior[trigger];
    const context: ScenarioContext = {
      agent: agent.ref,
      session: agent.session,
      workspace: agent.workspace,
      request: structuredClone(agent.request),
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
      shim: 'ready',
      ownership: this.sessions.size ? 'owned' : 'none',
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
  async closeSession(session: SessionRef): Promise<void> {
    this.before('closeSession');
    this.session(session);
    this.after('closeSession'); /* Orca has no run deletion. */
  }
  async prepareWorkspace(
    req: Parameters<RuntimePort['prepareWorkspace']>[0],
  ): ReturnType<RuntimePort['prepareWorkspace']> {
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
        const ref = WorkspaceRefSchema.parse(this.id('workspace'));
        this.workspaces.set(ref, { clean: true, changedFiles: [] });
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
  async disposeWorkspace(ws: WorkspaceRef): Promise<void> {
    this.before('disposeWorkspace');
    this.workspaces.delete(ws);
    this.after('disposeWorkspace');
  }
  async spawnAgent(req: SpawnRequest): Promise<AgentRef> {
    return this.command('spawnAgent', req.correlation, req, req.session, () => {
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
      if (!this.workspaces.has(workspace))
        this.workspaces.set(workspace, { clean: true, changedFiles: [] });
      const ref = AgentRefSchema.parse(this.id('agent'));
      const role = this.options.scenario?.role?.(req) ?? req.title;
      const agent: Agent = {
        ref,
        session: req.session,
        workspace,
        request: structuredClone(req),
        behavior: this.options.scenario?.roles[role] ?? {},
        turn: 1,
        generation: 0,
        state: 'working',
        terminalHandle: this.id('terminal'),
        paneKey: this.id('pane'),
      };
      this.agents.set(ref, agent);
      this.emit(req.session, {
        type: 'agent.status',
        agent: ref,
        state: 'working',
      });
      this.trigger(agent, 'spawn');
      return ref;
    });
  }
  async send(
    ref: AgentRef,
    msg: Parameters<RuntimePort['send']>[1],
  ): Promise<void> {
    this.before('send');
    await this.runDue();
    const agent = this.agent(ref);
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
    if (opts.removeWorkspace) this.workspaces.delete(agent.workspace);
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
    if (!value) throw fail('unknown_workspace');
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
    await this.runDue();
    const events = this.session(session);
    const next = RuntimeCursorSchema.parse(this.id('cursor'));
    this.cursors.set(next, { session, offset: events.length });
    const result = {
      events: structuredClone(events.slice(offset)),
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
        await this.execute(job);
      }
    } finally {
      this.pumping = false;
    }
  }
  private async execute({ agent: a, action, at }: Scheduled): Promise<void> {
    const emit = (body: EventBody) => this.emit(a.session, body, at);
    switch (action.type) {
      case 'submit': {
        const tokens = [
          ...new Set(
            a.request.prompt.match(/\baio_seat_[A-Za-z0-9_-]+\b/g) ?? [],
          ),
        ];
        if (tokens.length !== 1 || !this.options.submitter)
          throw new PortError(
            'validation',
            'missing_submitter_or_token',
            'Submission requires a submitter and one unique prompt seat token',
          );
        await this.options.submitter({
          agent: a.ref,
          ...this.identity(a.ref),
          seatToken: tokens[0]!,
          submission: structuredClone(action.submission),
        });
        break;
      }
      case 'push':
        if (!this.options.onPush) throw fail('missing_push_handler');
        else {
          await this.options.onPush({
            agent: a.ref,
            workspace: a.workspace,
            branch: action.branch,
            headSha: action.headSha,
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
        if (!a.request.keepOpen)
          this.scheduled.push({
            at: at + 120_000,
            order: ++this.sequence,
            agent: a,
            generation: a.generation,
            action: { type: 'auto-release' },
          });
        break;
      case 'auto-release':
        this.releaseAgent(a, at);
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
