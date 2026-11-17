import type { EventPayload } from '@ai-office/contracts/events';
import type { Attempt } from '@ai-office/domain';
import type { RuntimePort } from '../../ports/runtime.js';
import type { ScmPort } from '../../ports/scm.js';
import type { UsageLocateRef, UsagePort } from '../../ports/usage.js';
import type { RuntimeCursor, ScmCursor, SessionRef } from '../../ports/refs.js';
import type {
  Clock,
  Logger,
  RedactorFactory,
  ScheduledTimer,
  Scheduler,
} from '../../ports/services.js';
import type { EventStore, Unsubscribe } from '../../ports/stores.js';
import { Batch } from './batch.js';
import type { ObservationWorkflow } from './batch.js';
import { ingestRuntime } from './runtime.js';
import { ingestScm } from './scm.js';
import { budgetFormula, DEFAULT_BUDGET_FORMULA, ingestUsage } from './usage.js';
import type { UsageCheckpoint } from './usage.js';
export type { ObservationWorkflow } from './batch.js';
export { DEFAULT_BUDGET_FORMULA } from './usage.js';

export const OBSERVATION_TIMER_PREFIX = 'aio-observe:';
export interface ObservationLoopDeps {
  runtime: RuntimePort;
  scm: ScmPort;
  usage: UsagePort;
  store: EventStore;
  redactors: RedactorFactory;
  clock: Clock;
  scheduler: Scheduler;
  logger: Logger;
  workflows: () => readonly ObservationWorkflow[];
  budgetFormula?: string;
  /** Optional fallback lookup hints; recorded attempt.agentSession takes priority. */
  usageIdentity?: (
    attempt: Attempt,
  ) => Partial<
    Pick<
      UsageLocateRef,
      'reportedSessionId' | 'dispatchId' | 'transcriptMessageIds'
    >
  >;
  runtimeIntervalMs?: number;
  usageIntervalMs?: number;
  /** Overrides the §6.4 SCM cadence (15 s, 30 s with an open final-PR gate); fakes only. */
  scmIntervalMs?: number;
}
type Job = { runner: ObservationWorkflow } & (
  { kind: 'runtime'; session: SessionRef } | { kind: 'scm' | 'usage' }
);
type ScmCheckpoint = { cursor: ScmCursor; defaultSha?: string; poll?: number };

/** Composition: start after reconciliation, forward aio-observe timers to onTimer,
 * stop before closing adapters. One pending/runtime call per session; paused
 * workflows remain observed. Source cursors and their events commit via runner.
 */
export class ObservationLoop {
  private readonly formula;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Set<string>();
  private unsubscribe: Unsubscribe | undefined;
  constructor(private readonly deps: ObservationLoopDeps) {
    this.formula = budgetFormula(deps.budgetFormula ?? DEFAULT_BUDGET_FORMULA);
    for (const interval of [
      deps.runtimeIntervalMs ?? 2000,
      deps.usageIntervalMs ?? 3000,
      deps.scmIntervalMs ?? 15_000,
    ])
      if (!Number.isFinite(interval) || interval <= 0)
        throw new Error('Invalid observation interval');
  }
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.store.subscribe(() =>
      queueMicrotask(() => this.refresh()),
    );
    this.refresh();
  }
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const id of this.jobs.keys()) this.deps.scheduler.cancel(id);
    this.jobs.clear();
  }
  /** A stop does not abort a port read; drain before disposing the store. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }
  refresh(): void {
    if (!this.unsubscribe) return;
    const desired = new Map<string, Job>();
    for (const runner of this.deps.workflows()) {
      if (runner.state.workflow?.status !== 'running') continue;
      const key = (kind: string, scope = '') =>
        `${OBSERVATION_TIMER_PREFIX}${JSON.stringify([runner.workflowId, kind, scope])}`;
      desired.set(key('scm'), { kind: 'scm', runner });
      desired.set(key('usage'), { kind: 'usage', runner });
      for (const record of Object.values(runner.state.commands))
        if (
          record.result?.kind === 'runtime.openSession' &&
          record.result.result !== null &&
          'session' in record.result.result
        ) {
          const session = record.result.result.session as SessionRef;
          desired.set(key('runtime', session), {
            kind: 'runtime',
            runner,
            session,
          });
        }
    }
    for (const id of this.jobs.keys())
      if (!desired.has(id)) {
        this.deps.scheduler.cancel(id);
        this.jobs.delete(id);
      }
    for (const [id, job] of desired)
      if (!this.jobs.has(id) && !this.running.has(id)) {
        this.jobs.set(id, job);
        const delay =
          job.kind === 'scm'
            ? this.scmInterval(job.runner)
            : job.kind === 'runtime'
              ? (this.deps.runtimeIntervalMs ?? 2000)
              : (this.deps.usageIntervalMs ?? 3000);
        this.deps.scheduler.schedule({
          id,
          workflowId: job.runner.workflowId,
          fireAt: new Date(
            this.deps.clock.now().getTime() + delay,
          ).toISOString(),
        });
      }
  }
  async onTimer(timer: ScheduledTimer): Promise<void> {
    const job = this.jobs.get(timer.id);
    if (!job || this.running.has(timer.id)) return;
    this.jobs.delete(timer.id);
    this.running.add(timer.id);
    try {
      if (job.kind === 'runtime')
        await this.pollRuntime(job.runner, job.session);
      else if (job.kind === 'scm') await this.pollScm(job.runner);
      else
        for (const attempt of Object.values(job.runner.state.attempts)) {
          if (!this.unsubscribe) break;
          await this.pollUsage(job.runner, attempt.attemptId);
        }
    } catch {
      // Adapter errors can contain raw transcript/input; only log fixed metadata.
      this.deps.logger.warn(
        { source: job.kind },
        'Observation poll failed; cursor retained',
      );
    } finally {
      this.running.delete(timer.id);
      this.refresh();
    }
  }
  scmInterval(runner: ObservationWorkflow): number {
    if (this.deps.scmIntervalMs !== undefined) return this.deps.scmIntervalMs;
    return Object.values(runner.state.gates).some(
      (g) => g.status === 'open' && g.content.type === 'final-pr',
    )
      ? 30_000
      : 15_000;
  }
  pollRuntime(runner: ObservationWorkflow, session: SessionRef): Promise<void> {
    return this.serial(runner, `runtime:${session}`, async () => {
      const scope = JSON.stringify([runner.workflowId, session]);
      const cursor = this.deps.store.readCursor(
        'observation.runtime',
        scope,
      ) as RuntimeCursor | null;
      const result = await this.deps.runtime.observe(session, cursor);
      const batch = new Batch(runner, this.deps.store);
      ingestRuntime(batch, result.events, this.deps.redactors);
      await runner.append(batch.drafts, [
        { source: 'observation.runtime', scope, value: result.cursor },
      ]);
    });
  }
  pollUsage(
    runner: ObservationWorkflow,
    attemptId: string,
    identity: Partial<UsageLocateRef> = {},
  ): Promise<void> {
    return this.serial(runner, `usage:${attemptId}`, async () => {
      const attempt = runner.state.attempts[attemptId];
      if (!attempt || !attempt.agentRef) return;
      const hints = { ...this.deps.usageIdentity?.(attempt), ...identity };
      // T28 forwards this CP4 field onto Attempt; use the contract type while
      // the independently owned domain forwarding change is still in flight.
      const { agentSession } = attempt as Attempt &
        Pick<EventPayload<'submission.accepted'>, 'agentSession'>;
      const provider = attempt.agent === 'codex' ? 'codex' : 'claude';
      const reportedSessionId =
        agentSession?.provider === provider
          ? agentSession.id
          : hints.reportedSessionId;
      const ref = await this.deps.usage.locate({
        ...hints,
        ...(reportedSessionId === undefined ? {} : { reportedSessionId }),
        attemptId,
        agent: attempt.agent,
        dispatchId: hints.dispatchId ?? attempt.agentRef,
      });
      if (!ref) return;
      const scope = JSON.stringify([
        runner.workflowId,
        attemptId,
        ref.sessionId,
      ]);
      const checkpoint = this.deps.store.readCursor(
        'observation.usage',
        scope,
      ) as UsageCheckpoint | null;
      const result = await this.deps.usage.read(
        ref,
        checkpoint?.cursor ?? null,
      );
      const batch = new Batch(runner, this.deps.store);
      const previous = ingestUsage(
        batch,
        attempt,
        ref,
        result.samples,
        checkpoint,
        this.formula,
      );
      await runner.append(batch.drafts, [
        {
          source: 'observation.usage',
          scope,
          value: {
            cursor: result.cursor,
            sessionId: ref.sessionId,
            ...(previous === undefined ? {} : { previous }),
          },
        },
      ]);
    });
  }
  pollScm(runner: ObservationWorkflow): Promise<void> {
    return this.serial(runner, 'scm', async () => {
      const workflow = runner.state.workflow!;
      const scope = workflow.id;
      const checkpoint = this.deps.store.readCursor(
        'observation.scm',
        scope,
      ) as ScmCheckpoint | null;
      const result = await this.deps.scm.poll(
        workflow.repo.github,
        checkpoint?.cursor ?? null,
      );
      const head = await this.deps.scm.compareBranch(
        workflow.repo.github,
        workflow.repo.defaultBranch,
        workflow.repo.defaultBranch,
      );
      const batch = new Batch(runner, this.deps.store);
      const redactor = this.deps.redactors.forAttempt({
        attemptId: 'scm',
        currentBranch: null,
        defaultBranch: workflow.repo.defaultBranch,
        integrationBranch: workflow.integrationBranch,
      });
      ingestScm(batch, result.events, this.deps.store, redactor);
      if (head)
        batch.anomaly(
          {
            kind: 'default-branch',
            sha: head.headSha,
            ...(checkpoint?.defaultSha === undefined
              ? {}
              : { previousSha: checkpoint.defaultSha }),
          },
          {
            externalKey: `gh:default:${workflow.id}:${checkpoint?.poll ?? 0}:${checkpoint?.defaultSha ?? 'initial'}:${head.headSha}`,
            occurredAt: this.deps.clock.now().toISOString(),
          },
          'scm',
        );
      await runner.append(batch.drafts, [
        {
          source: 'observation.scm',
          scope,
          value: {
            cursor: result.cursor,
            poll: (checkpoint?.poll ?? 0) + 1,
            ...(head
              ? { defaultSha: head.headSha }
              : checkpoint?.defaultSha === undefined
                ? {}
                : { defaultSha: checkpoint.defaultSha }),
          },
        },
      ]);
    });
  }
  private serial(
    runner: ObservationWorkflow,
    source: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = JSON.stringify([runner.workflowId, source]);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const current = prior
      .catch(() => undefined)
      .then(async () => {
        if (runner.state.workflow?.status === 'running') await operation();
      });
    this.queues.set(key, current);
    void current
      .finally(() => {
        if (this.queues.get(key) === current) this.queues.delete(key);
      })
      .catch(() => undefined);
    return current;
  }
}
