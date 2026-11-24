import type {
  CommandResult,
  ExternalCommand,
  ExternalCommandKind,
} from '@ai-office/contracts/events';
import type { ErrorInfo } from '@ai-office/domain';
import { PortError } from '../../ports/errors.js';
import type {
  AgentRef,
  QuestionRef,
  SessionRef,
  WorkspaceRef,
} from '../../ports/refs.js';
import type { Correlation, RuntimePort } from '../../ports/runtime.js';
import { CREATE_PENDING_WINDOW_MS } from '../../ports/scm.js';
import type { ScmPort } from '../../ports/scm.js';
import type { Logger, Scheduler } from '../../ports/services.js';
import type { SpecStore } from '../../ports/stores.js';
import type { HealthMonitor } from '../health/health-monitor.js';
import { retryDelay, toErrorInfo } from './errors.js';

type ArgsOf<K extends ExternalCommandKind> = Extract<
  ExternalCommand,
  { kind: K }
>['args'];
type ResultOf<K extends ExternalCommandKind> = Extract<
  CommandResult,
  { kind: K }
>['result'];

/** A `command.issued` as the executor runs it: args exactly as recorded (§11.5). */
export interface IssuedCommand {
  workflowId: string;
  commandId: string;
  command: ExternalCommand;
  orcaRequestId?: string;
  stageId?: string;
  attemptId?: string;
}

export interface HandlerContext {
  issued: IssuedCommand;
  correlation: Correlation;
}

export type CommandHandler<K extends ExternalCommandKind> = (
  args: ArgsOf<K>,
  ctx: HandlerContext,
) => Promise<ResultOf<K>>;

/**
 * One handler per command kind. Generic over `ExternalCommand` so later tasks
 * add kinds (e.g. rev2.10 progressive merge) by adding a handler, without
 * touching the runner or the retry logic.
 */
export type CommandHandlers = {
  [K in ExternalCommandKind]?: CommandHandler<K>;
};

export type CommandOutcome =
  | { ok: true; result: CommandResult; attempts: number }
  | { ok: false; error: ErrorInfo; attempts: number };

/**
 * What a spawned agent is told. Derived from args only (never re-read from
 * disk), so a retry sends byte-identical input under the same request ID.
 */
export const spawnPrompt = (
  args: ArgsOf<'runtime.spawnAgent'>,
  commandId: string,
): string =>
  [
    `aio:${commandId}`,
    `Read the AI Office spec at ${args.specPath} (sha256 ${args.specSha256}) and follow it exactly.`,
  ].join('\n');

/** The default handlers: one RuntimePort / ScmPort call per kind (§11.1, §11.2). */
export const portHandlers = (ports: {
  runtime: RuntimePort;
  scm: ScmPort;
  specStore: SpecStore;
}): CommandHandlers => {
  const { runtime, scm, specStore } = ports;
  return {
    'runtime.reclaimSession': async (args) =>
      runtime.reclaimSession(args.session as SessionRef),
    'runtime.openSession': async (args, { issued, correlation }) => ({
      session: await runtime.openSession({
        workflowId: issued.workflowId,
        repo: args.repo,
        objective: args.objective,
        correlation,
      }),
    }),
    'runtime.prepareWorkspace': async (args, { correlation }) => {
      return runtime.prepareWorkspace({
        ...args,
        session: args.session as SessionRef,
        correlation,
      });
    },
    'runtime.disposeWorkspace': async (args) => {
      await runtime.disposeWorkspace(args.workspace as WorkspaceRef);
      return {};
    },
    'runtime.inspectWorkspace': (args) =>
      runtime.inspectWorkspace(args.workspace as WorkspaceRef),
    'runtime.spawnAgent': async (args, { issued, correlation }) => {
      // §11.5: a missing or altered spec file is a bug; it is never regenerated.
      if (!specStore.verify(args.specPath, args.specSha256))
        throw new PortError(
          'bug',
          'spec_mismatch',
          `Spec file for ${issued.commandId} is missing or its sha256 changed`,
        );
      const agent = await runtime.spawnAgent({
        session: args.session as SessionRef,
        agent: args.agent,
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.effort === undefined ? {} : { effort: args.effort }),
        title: args.title,
        prompt: spawnPrompt(args, issued.commandId),
        workspace:
          args.workspace.kind === 'new-worktree'
            ? args.workspace
            : {
                ...args.workspace,
                workspace: args.workspace.workspace as WorkspaceRef,
              },
        correlation,
        keepOpen: args.keepOpen,
      });
      // M5 §4.2: record the created worktree so cleanup reads state only.
      const workspace =
        args.workspace.kind === 'new-worktree'
          ? runtime.spawnedWorkspace?.(issued.commandId)
          : undefined;
      return workspace === undefined ? { agent } : { agent, workspace };
    },
    'runtime.send': async (args, { correlation }) => {
      await runtime.send(args.agent as AgentRef, {
        subject: args.subject,
        body: args.body,
        correlation,
      });
      return {};
    },
    'runtime.answer': async (args, { correlation }) => {
      await runtime.answer(
        args.question as QuestionRef,
        args.body,
        correlation,
      );
      return {};
    },
    'runtime.stop': async (args) => {
      await runtime.stop(args.agent as AgentRef);
      return {};
    },
    'runtime.release': async (args) => {
      await runtime.release(args.agent as AgentRef, {
        removeWorkspace: args.removeWorkspace,
      });
      return {};
    },
    'scm.ensureLabels': async (args) => {
      await scm.ensureLabels(args.repo, args.labels);
      return {};
    },
    'scm.ensureBranch': async (args, { correlation }) => {
      await scm.ensureBranch(args.repo, args.name, args.from, correlation);
      return {};
    },
    'scm.compareBranch': (args) =>
      scm.compareBranch(args.repo, args.base, args.head),
    'scm.deleteBranch': async (args) => {
      await scm.deleteBranch(args.repo, args.name);
      return {};
    },
    'scm.createIssue': async (args, { correlation }) => {
      const { repo, ...draft } = args;
      const ref = await scm.createIssue(repo, draft, correlation);
      return {
        issue: ref.number,
        url: ref.url,
      };
    },
    'scm.updateIssue': async (args) => {
      await scm.updateIssue(args.issue, args.patch);
      return {};
    },
    'scm.comment': async (args, { correlation }) => {
      const { repo, number } = args.target;
      await scm.comment({ repo, number }, args.body, correlation);
      return {};
    },
    // CP1: only the §4.8 duplicate-comment compensation emits this.
    'scm.deleteComment': async (args) => {
      const { repo, number } = args.target;
      await scm.deleteComment({ repo, number }, args.commentId);
      return {};
    },
    'scm.setLabels': async (args) => {
      const { repo, number } = args.target;
      await scm.setLabels({ repo, number }, args.labels);
      return {};
    },
    'scm.openPR': async (args, { correlation }) => {
      const { repo, ...draft } = args;
      const ref = await scm.openPR(repo, draft, correlation);
      return { pr: ref.number, url: ref.url };
    },
    'scm.updatePR': async (args) => {
      await scm.updatePR(args.pr, args.patch);
      return {};
    },
    'scm.mergePR': (args) =>
      scm.mergePR(args.pr, {
        method: args.method,
        expectedHeadSha: args.expectedHeadSha,
        ...(args.expectedBaseSha === undefined
          ? {}
          : { expectedBaseSha: args.expectedBaseSha }),
        ...(args.expectedBase === undefined
          ? {}
          : { expectedBase: args.expectedBase }),
      }),
  };
};

/** Scheduler timer ids the executor owns; the timer sink routes them back here. */
export const RETRY_TIMER_PREFIX = 'aio-retry:';
/** One `retryAfterMs` wait is capped at this (SPEC §15). */
export const RETRY_AFTER_MAX_MS = 15 * 60_000;
/**
 * The total of one command's `retryAfterMs` waits (M3_PLAN §4.7); beyond it
 * the command fails. Covers a whole create pending window plus one more scan.
 */
export const RETRY_AFTER_TOTAL_MS = Math.max(
  3 * 60_000,
  CREATE_PENDING_WINDOW_MS + 60_000,
);
/**
 * `rate_limited` waits are charged to their own total instead: a primary
 * reset can be most of an hour away (§12.2). Beyond RATE_LIMIT_PAUSE_MS of
 * them the workflow is paused `scm_unhealthy`, and that time is excluded
 * from RETRY_AFTER_TOTAL_MS (M3_PLAN §4.7).
 */
export const RATE_LIMIT_TOTAL_MS = 65 * 60_000;
export const RATE_LIMIT_PAUSE_MS = 5 * 60_000;

export interface CommandExecutorDeps {
  handlers: CommandHandlers;
  health?: HealthMonitor;
  /** Backoff waits go through the Scheduler, never real time (plan M1-T23). */
  scheduler: Scheduler;
  clock: { now(): Date };
  logger: Logger;
  /** Jitter source in [0, 1); injectable for deterministic tests. */
  random?: () => number;
}

/**
 * CommandExecutor (§11.4, §11.5): runs one issued command through its handler
 * with the §15 retry policy. It never touches the event store; the runner
 * records the outcome. Every retry reuses `issued` unchanged.
 */
export class CommandExecutor {
  private readonly waiting = new Map<string, () => void>();
  private readonly random: () => number;
  private nextWait = 0;

  constructor(private readonly deps: CommandExecutorDeps) {
    this.random = deps.random ?? Math.random;
  }

  async execute(issued: IssuedCommand): Promise<CommandOutcome> {
    const handler = this.deps.handlers[issued.command.kind] as
      CommandHandler<ExternalCommandKind> | undefined;
    const log = this.deps.logger.child({
      workflowId: issued.workflowId,
      commandId: issued.commandId,
      ...(issued.attemptId === undefined
        ? {}
        : { attemptId: issued.attemptId }),
    });
    if (handler === undefined)
      return {
        ok: false,
        attempts: 1,
        error: {
          category: 'bug',
          code: 'no_command_handler',
          message: `No handler for ${issued.command.kind}`,
          retryable: false,
        },
      };
    const ctx: HandlerContext = {
      issued,
      correlation: {
        workflowId: issued.workflowId,
        commandId: issued.commandId,
        ...(issued.attemptId === undefined
          ? {}
          : { attemptId: issued.attemptId }),
      },
    };
    const kind = issued.command.kind;
    const component = kind.startsWith('scm.') ? 'scm' : 'runtime';
    let retry = 0;
    let waitedMs = 0;
    let limitedMs = 0;
    let held = false;
    const release = async () => {
      if (!held) return;
      held = false;
      await this.deps.health?.releaseScm(issued.commandId);
    };
    try {
      for (let attempt = 1; ; attempt++) {
        if (this.deps.health !== undefined)
          await this.deps.health.waitUntilDispatchable(kind);
        const startedAt = this.deps.clock.now().getTime();
        try {
          const result = await handler(issued.command.args, ctx);
          if (this.deps.health !== undefined)
            await this.deps.health.record(component, startedAt);
          return {
            ok: true,
            attempts: attempt,
            result: { kind, result } as CommandResult,
          };
        } catch (thrown) {
          const error = toErrorInfo(thrown);
          const retryAfterMs =
            thrown instanceof PortError ? thrown.retryAfterMs : undefined;
          const waitStated = retryAfterMs !== undefined && retryAfterMs > 0;
          if (error.category !== 'rate_limited') await release();
          if (this.deps.health !== undefined)
            await this.deps.health.record(
              component,
              startedAt,
              error.category,
              waitStated,
            );
          // An outage leaves the outbox command pending, with its original args/ID.
          // Recovery starts a fresh retry budget; attempts still counts real calls.
          if (
            error.category === 'transient' &&
            this.deps.health?.dispatchBlockedFor(kind)
          ) {
            await this.deps.health.waitUntilDispatchable(kind);
            retry = 0;
            continue;
          }
          // PP4: an adapter-stated wait (any category) is honoured without
          // spending the category's retries, up to a per-command total (§4.7).
          if (waitStated && error.category === 'rate_limited') {
            await this.deps.health?.noteRateLimit(error.code, retryAfterMs);
            const delay = Math.min(
              retryAfterMs,
              RETRY_AFTER_MAX_MS,
              RATE_LIMIT_TOTAL_MS - limitedMs,
            );
            log.warn(
              {
                kind,
                attempt,
                error,
                retryInMs: delay > 0 ? delay : undefined,
              },
              'command attempt failed',
            );
            if (delay <= 0) return { ok: false, error, attempts: attempt };
            limitedMs += delay;
            if (limitedMs > RATE_LIMIT_PAUSE_MS && !held) {
              held = true;
              await this.deps.health?.holdScm(
                issued.workflowId,
                issued.commandId,
              );
            }
            await this.wait(issued, delay);
            continue;
          }
          if (waitStated) {
            const delay = Math.min(
              retryAfterMs,
              RETRY_AFTER_MAX_MS,
              RETRY_AFTER_TOTAL_MS - waitedMs,
            );
            log.warn(
              {
                kind,
                attempt,
                error,
                retryInMs: delay > 0 ? delay : undefined,
              },
              'command attempt failed',
            );
            if (delay <= 0) return { ok: false, error, attempts: attempt };
            waitedMs += delay;
            await this.wait(issued, delay);
            continue;
          }
          const delay = retryDelay(error.category, retry++, this.random);
          log.warn(
            { kind, attempt, error, retryInMs: delay },
            'command attempt failed',
          );
          if (delay === undefined)
            return { ok: false, error, attempts: attempt };
          if (delay > 0) await this.wait(issued, delay);
        }
      }
    } finally {
      await release();
    }
  }

  /** Scheduler sink entry for `RETRY_TIMER_PREFIX` ids. */
  wake(timerId: string): void {
    const resume = this.waiting.get(timerId);
    if (resume === undefined) return;
    this.waiting.delete(timerId);
    resume();
  }

  /** Retries currently waiting on their backoff timer. */
  get pendingRetries(): number {
    return this.waiting.size;
  }

  private wait(issued: IssuedCommand, delayMs: number): Promise<void> {
    const id = `${RETRY_TIMER_PREFIX}${issued.commandId}#${++this.nextWait}`;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.deps.scheduler.schedule({
        id,
        workflowId: issued.workflowId,
        fireAt: new Date(
          this.deps.clock.now().getTime() + delayMs,
        ).toISOString(),
      });
    });
  }
}
