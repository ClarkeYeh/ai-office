import { createHash } from 'node:crypto';
import type { WorkflowTemplate } from '@ai-office/contracts/template';
import type { DomainEvent, RepoSnapshot } from '@ai-office/contracts/events';
import type { StartWorkflow } from '@ai-office/domain';
import type { RuntimePort } from '../../../ports/runtime.js';
import type { ScmPort } from '../../../ports/scm.js';
import type { EventStore, SpecStore } from '../../../ports/stores.js';
import {
  FakeClock,
  InMemoryEventStore,
  InMemorySeatTokenStore,
  ManualScheduler,
  MemoryLogger,
  SeqIdGen,
} from '../../../test-support/index.js';
import { CommandExecutor, portHandlers } from '../../commands/executor.js';
import { WorkflowRunners } from '../runners.js';
import type { RunnerReact, WorkflowRunnerDeps } from '../workflow-runner.js';

export const WORKFLOW_ID = 'wf-1';
export const START = '2026-11-17T00:00:00.000Z';
export const CLI_PATH = '/opt/ai-office/apps/cli/dist/main.js';

export const repo = (): RepoSnapshot => ({
  repoId: 'repo-1',
  localPath: '/repos/demo',
  orcaRepoId: 'orca-repo-1',
  github: { owner: 'octo', name: 'demo' },
  defaultBranch: 'main',
  visibility: 'public',
  ownerLogin: 'octo',
  defaultBranchProtected: true,
});

/** The built-in feature-to-pr template, inlined (templates are template-fs only). */
const builtinTemplate = (): WorkflowTemplate => ({
  apiVersion: 'ai-office/v1alpha1',
  id: 'feature-to-pr',
  name: '需求到 PR',
  roles: {
    lead: { agent: 'claude-code', effort: 'high', scope: 'lead' },
    pm: { agent: 'claude-code' },
    architect: { agent: 'claude-code' },
    engineer: { agent: 'codex' },
    integrator: { agent: 'claude-code' },
  },
  defaults: {
    integrationBranch: 'ai-office/{shortId}-{slug}',
    maxReruns: 2,
    budget: { hardLimitMultiplier: 2 },
    workflowBudget: { tokens: 3_000_000 },
  },
  stages: [
    {
      id: 'meeting',
      kind: 'meeting',
      facilitator: 'lead',
      participants: ['pm', 'architect', 'engineer'],
      maxRounds: 2,
      timeouts: { roundMin: 15, stageMin: 60 },
      budget: { tokens: 300_000, maxTurns: 60 },
      conclusion: { requireTechDecisions: true },
      gate: { id: 'conclusion', title: '結論定案', optional: true },
    },
    {
      id: 'breakdown',
      kind: 'planning',
      owner: 'lead',
      from: 'meeting',
      timeouts: { stageMin: 30 },
      budget: { tokens: 200_000, maxTurns: 40 },
      gate: {
        id: 'task-split',
        title: '任務拆分',
        optional: true,
        editable: ['title', 'body', 'acceptance', 'role', 'agent', 'deps'],
      },
    },
    {
      id: 'implement',
      kind: 'implement',
      role: 'engineer',
      from: 'breakdown',
      maxParallel: 3,
      timeouts: { itemMin: 45 },
      budget: {
        tokens: 1_500_000,
        perItem: { tokens: 400_000, maxTurns: 120 },
      },
      onCall: { role: 'lead', questionTimeoutMin: 10 },
    },
    {
      id: 'integrate',
      kind: 'integrate',
      owner: 'integrator',
      escalateOn: ['unresolvable-conflict', 'ci-failed-twice'],
      timeouts: { stageMin: 60 },
      budget: { tokens: 400_000, maxTurns: 100 },
    },
    {
      id: 'final-pr',
      kind: 'final-pr',
      maxRevisions: 2,
      gate: { id: 'final-pr', title: '最終 PR' },
    },
  ],
});

export const startWorkflow = (
  workflowId = WORKFLOW_ID,
  occurredAt = START,
): StartWorkflow => ({
  type: 'StartWorkflow',
  meta: { occurredAt, source: 'user' },
  workflowId,
  shortId: 'ab12',
  template: builtinTemplate(),
  repo: repo(),
  requirement: 'Add dark mode toggle',
  limits: { globalAgents: 10 },
});

/** Spec files in memory; `tamper` simulates an edited or deleted file. */
export class MemorySpecStore implements SpecStore {
  readonly files = new Map<string, string>();
  writes = 0;
  write(attemptId: string, content: string) {
    this.writes++;
    const path = `/data/specs/${attemptId}.md`;
    this.files.set(path, content);
    return { path, sha256: sha256(content) };
  }
  verify(path: string, hash: string): boolean {
    const content = this.files.get(path);
    return content !== undefined && sha256(content) === hash;
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  tamper(path: string): void {
    this.files.set(path, `${this.files.get(path) ?? ''}\nedited`);
  }
}

const sha256 = (content: string) =>
  createHash('sha256').update(content).digest('hex');

type Reply = Error | 'hang';

/**
 * Stub runtime + SCM: records every call with its arguments; per-method
 * scripted replies (an Error to throw, or `'hang'` to never settle), else a
 * deterministic success.
 */
export class StubWorld {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly scripts = new Map<string, Reply[]>();
  private readonly hung = new Set<string>();

  script(method: string, ...replies: Reply[]): this {
    this.scripts.set(method, [...(this.scripts.get(method) ?? []), ...replies]);
    return this;
  }

  /** Every call of `method` (or all, with `'*'`) never settles. */
  hang(method: string): this {
    this.hung.add(method);
    return this;
  }

  callsOf(method: string): unknown[][] {
    return this.calls
      .filter((call) => call.method === method)
      .map((call) => call.args);
  }

  private call<T>(method: string, args: unknown[], value: T): Promise<T> {
    this.calls.push({ method, args: structuredClone(args) });
    if (this.hung.has(method) || this.hung.has('*'))
      return new Promise<T>(() => undefined);
    const reply = this.scripts.get(method)?.shift();
    if (reply === 'hang') return new Promise<T>(() => undefined);
    if (reply !== undefined) return Promise.reject(reply);
    return Promise.resolve(value);
  }

  readonly runtime = {
    openSession: (req: unknown) => this.call('openSession', [req], 'session-1'),
    prepareWorkspace: (req: unknown) =>
      this.call('prepareWorkspace', [req], 'ws-1'),
    disposeWorkspace: (ws: unknown) =>
      this.call('disposeWorkspace', [ws], undefined),
    inspectWorkspace: (ws: unknown) =>
      this.call('inspectWorkspace', [ws], { clean: true, changedFiles: [] }),
    spawnAgent: (req: { title: string }) =>
      this.call('spawnAgent', [req], `agent:${req.title}`),
    send: (agent: unknown, msg: unknown) =>
      this.call('send', [agent, msg], undefined),
    answer: (...args: unknown[]) => this.call('answer', args, undefined),
    stop: (agent: unknown) => this.call('stop', [agent], undefined),
    release: (...args: unknown[]) => this.call('release', args, undefined),
  } as unknown as RuntimePort;

  readonly scm = {
    ensureLabels: (...args: unknown[]) =>
      this.call('ensureLabels', args, undefined),
    ensureBranch: (...args: unknown[]) =>
      this.call('ensureBranch', args, undefined),
    deleteBranch: (...args: unknown[]) =>
      this.call('deleteBranch', args, undefined),
    createIssue: (repo: { owner: string; name: string }, ...rest: unknown[]) =>
      this.call('createIssue', [repo, ...rest], { repo, number: 7 }),
    updateIssue: (...args: unknown[]) =>
      this.call('updateIssue', args, undefined),
    comment: (...args: unknown[]) => this.call('comment', args, undefined),
    setLabels: (...args: unknown[]) => this.call('setLabels', args, undefined),
    openPR: (repo: { owner: string; name: string }, ...rest: unknown[]) =>
      this.call('openPR', [repo, ...rest], { repo, number: 8 }),
    updatePR: (...args: unknown[]) => this.call('updatePR', args, undefined),
    mergePR: (...args: unknown[]) =>
      this.call('mergePR', args, { mergeCommitSha: 'abcdef1' }),
  } as unknown as ScmPort;
}

export interface HarnessOptions {
  world?: StubWorld;
  react?: RunnerReact;
  /** Shared across a simulated restart. */
  store?: EventStore;
  seatTokens?: InMemorySeatTokenStore;
  specStore?: MemorySpecStore;
}

export const harness = (options: HarnessOptions = {}) => {
  const clock = new FakeClock(START);
  const ids = new SeqIdGen();
  const store = options.store ?? new InMemoryEventStore(clock, ids);
  const world = options.world ?? new StubWorld();
  const seatTokens = options.seatTokens ?? new InMemorySeatTokenStore();
  const specStore = options.specStore ?? new MemorySpecStore();
  const logger = new MemoryLogger();
  const scheduler = new ManualScheduler(clock, (timer) =>
    runners.onTimer(timer),
  );
  const executor = new CommandExecutor({
    handlers: portHandlers({
      runtime: world.runtime,
      scm: world.scm,
      specStore,
    }),
    scheduler,
    clock,
    logger,
    random: () => 0.5,
  });
  const deps: WorkflowRunnerDeps = {
    store,
    executor,
    scheduler,
    clock,
    ids,
    logger,
    seatTokens,
    specStore,
    cliPath: CLI_PATH,
    ...(options.react === undefined ? {} : { react: options.react }),
  };
  const runners = new WorkflowRunners(deps);
  const events = (): DomainEvent[] => store.read({});
  return {
    clock,
    ids,
    store,
    world,
    seatTokens,
    specStore,
    logger,
    scheduler,
    executor,
    runners,
    events,
    /** Advances the fake clock and delivers due timers, then settles. */
    async advance(ms: number) {
      clock.advance(ms);
      scheduler.runDue();
      await flush();
    },
    trace: () => events().map(traceLine),
  };
};

/** Lets pending port promises settle and their results drain. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Same line format as engine's simulator `trace()`, for golden comparison. */
export const traceLine = (event: DomainEvent): string => {
  const p = event.payload as Record<string, unknown>;
  const detail = (() => {
    switch (event.type) {
      case 'command.issued':
      case 'command.succeeded':
      case 'command.failed':
        return `${String(p.kind)} ${String(p.commandId)}`;
      case 'timer.scheduled':
      case 'timer.fired':
      case 'timer.cancelled':
        return String(p.timerId);
      case 'stage.started':
      case 'stage.completed':
      case 'stage.failed':
        return `${String(p.stageId)}#${String(p.attempt)}`;
      case 'gate.opened':
      case 'gate.decided':
      case 'gate.closed':
        return String(p.gateId);
      case 'workflow.paused':
      case 'workflow.resumed':
        return String(p.reason);
      default:
        return typeof p.attemptId === 'string' ? p.attemptId : '';
    }
  })();
  return `${event.occurredAt} ${event.type}${detail === '' ? '' : ` ${detail}`}`;
};
