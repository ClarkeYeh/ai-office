import {
  AgentSubmissionSchema,
  MergeFailureReasonSchema,
  SubmissionHeadersSchema,
  SUBMISSION_FAILURE_HTTP_STATUS,
  SUBMISSION_RESPONSE_HTTP_STATUS,
} from '@ai-office/contracts/agent-submission';
import type {
  AgentSubmission,
  SubmissionFailureResponse,
  SubmissionResponse,
} from '@ai-office/contracts/agent-submission';
import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type { DomainEvent, EventPayload } from '@ai-office/contracts/events';
import type { Attempt } from '@ai-office/domain';
import type { RuntimePort } from '../../ports/runtime.js';
import { PortError } from '../../ports/errors.js';
import type {
  Clock,
  IdGen,
  Logger,
  Redactor,
  ScheduledTimer,
  Scheduler,
} from '../../ports/services.js';
import type { EventStore, SeatTokenStore } from '../../ports/stores.js';
import type { WorkflowRunners } from '../runner/runners.js';
import type { WorkflowRunner } from '../runner/workflow-runner.js';
import { toErrorInfo } from '../commands/errors.js';

export type SubmissionResult = {
  status: number;
  body:
    | SubmissionResponse
    | SubmissionFailureResponse
    | { error: string }
    | {
        issues: { path: (string | number)[]; code: string; message: string }[];
      };
};
export interface HandleSubmissionDeps {
  runners: Pick<WorkflowRunners, 'all'>;
  runtime: Pick<RuntimePort, 'resolveCaller'>;
  seatTokens: SeatTokenStore;
  store: EventStore;
  redactor: Redactor;
  clock: Clock;
  scheduler: Scheduler;
  ids: IdGen;
  logger: Pick<Logger, 'error'>;
}
type Located = { runner: WorkflowRunner; attempt: Attempt };
type Accepted = {
  runner: WorkflowRunner;
  submissionId: string;
  submission: AgentSubmission;
};
export const SUBMISSION_WAIT_PREFIX = 'submission-wait/';
/** Consecutive failed submissions of one attempt before `error.recorded` surfaces them. */
export const SUBMISSION_FAILURE_STREAK = 3;
const RETRYABLE: ReadonlySet<string> = new Set([
  'transient',
  'rate_limited',
  'identity',
]);

/** Gateway use case. Wire scheduler deliveries to onTimer before runners.onTimer. */
export class HandleSubmission {
  private closed = false;
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Per attempt; reset by any answered submission (accepted or rejected). */
  private readonly failures = new Map<string, number>();
  private readonly waits = new Map<
    string,
    { workflowId: string; deadline: number; finish: () => void }
  >();
  constructor(private readonly deps: HandleSubmissionDeps) {}

  /**
   * Never throws: a failure is logged with a request id, answered with a typed
   * §13 error, and a streak of them is recorded against the attempt (§15).
   */
  async handle(headers: unknown, body: unknown): Promise<SubmissionResult> {
    const seen: { located?: Located } = {};
    try {
      const result = await this.process(headers, body, seen);
      if (seen.located) this.failures.delete(seen.located.attempt.attemptId);
      return result;
    } catch (error) {
      return this.fail(error, seen.located);
    }
  }

  private async process(
    headers: unknown,
    body: unknown,
    seen: { located?: Located },
  ): Promise<SubmissionResult> {
    const parsed = SubmissionHeadersSchema.safeParse(headers);
    if (!parsed.success)
      return this.reject(undefined, 'identity_mismatch', 401);
    const h = parsed.data;
    const token = h.authorization.slice('Bearer '.length);
    const attemptId = this.deps.seatTokens.verify(token);
    const located = attemptId === null ? undefined : this.locate(attemptId);
    if (!located) return this.reject(undefined, 'identity_mismatch', 401);
    seen.located = located;
    const terminal = h['x-aio-terminal-handle'];
    const paneKey = h['x-aio-pane-key'];
    if (terminal !== undefined || paneKey !== undefined) {
      if (terminal === undefined || paneKey === undefined)
        return this.reject(located, 'identity_mismatch', 403);
      const caller = await this.deps.runtime.resolveCaller({
        terminalHandle: terminal,
        paneKey,
      });
      if (caller === null || caller !== located.attempt.agentRef)
        return this.reject(located, 'identity_mismatch', 403);
    } else if (
      located.attempt.agent !== 'codex' ||
      this.terminal(located.attempt)
    ) {
      return this.reject(located, 'identity_mismatch', 403);
    }
    // Serialize only acceptance/deduplication, never the 120-second response wait.
    const key = located.runner.workflowId;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.locate(located.attempt.attemptId);
        if (
          !current ||
          this.deps.seatTokens.verify(token) !== current.attempt.attemptId ||
          this.terminal(current.attempt)
        ) {
          return this.reject(current, 'identity_mismatch', 401);
        }
        return this.accept(current, body, h['x-aio-agent-session']);
      });
    this.locks.set(key, next);
    let result: SubmissionResult | Accepted;
    try {
      result = await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
    if ('status' in result) return result;
    if (result.submission.kind !== 'merge-request')
      return this.response({
        status: 'accepted',
        submissionId: result.submissionId,
      });
    return this.waitForMerge(result);
  }

  /** Release HTTP waits before closing the listener; accepted work stays durable. */
  close(): void {
    this.closed = true;
    for (const wait of this.waits.values()) wait.finish();
  }

  /** Returns true for a timer owned here; other timers belong to WorkflowRunners. */
  onTimer(timer: ScheduledTimer): boolean {
    if (!timer.id.startsWith(SUBMISSION_WAIT_PREFIX)) return false;
    const wait = this.waits.get(timer.id);
    if (wait && wait.workflowId === timer.workflowId) {
      if (this.deps.clock.now().getTime() >= wait.deadline) wait.finish();
      else
        this.deps.scheduler.schedule({
          ...timer,
          fireAt: new Date(wait.deadline).toISOString(),
        });
    }
    return true;
  }

  private terminal(attempt: Attempt): boolean {
    return (
      attempt.released || ['exited', 'lost', 'error'].includes(attempt.state)
    );
  }
  private locate(id: string): Located | undefined {
    for (const runner of this.deps.runners.all()) {
      const attempt = runner.state.attempts[id];
      if (attempt) return { runner, attempt };
    }
    return undefined;
  }
  private async accept(
    located: Located,
    body: unknown,
    sessionId?: string,
  ): Promise<SubmissionResult | Accepted> {
    const { runner, attempt } = located;
    const parsed = AgentSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      await this.reject(located, 'schema', 400);
      return {
        status: 400,
        body: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((p) =>
              typeof p === 'number' ? p : String(p),
            ),
            code: issue.code,
            // Zod messages may contain user-controlled enum keys or values.
            message: this.deps.redactor.maskSecrets(issue.message),
          })),
        },
      };
    }
    const submission = this.deps.redactor.maskSecrets(parsed.data);
    if (
      submission.kind === 'merge-request' ||
      submission.kind === 'rework-request'
    ) {
      // One merge-queue attempt reviews a PR in several rounds: once the PR is
      // back in review, earlier rework requests were consumed, not replayed.
      const inReview = Object.values(runner.state.workItems).some(
        (item) =>
          item.pr === submission.payload.pr && item.status === 'in_review',
      );
      const existing = Object.values(runner.state.submissions).find(
        (record) => {
          const old = record.submission;
          return (
            record.attemptId === attempt.attemptId &&
            !(old.kind === 'rework-request' && inReview) &&
            old.kind === submission.kind &&
            (old.kind === 'merge-request' || old.kind === 'rework-request') &&
            old.payload.pr === submission.payload.pr &&
            (old.kind !== 'merge-request' ||
              submission.kind !== 'merge-request' ||
              old.payload.expectedHeadSha ===
                submission.payload.expectedHeadSha)
          );
        },
      );
      // Query an already accepted operation even after its review has advanced.
      if (existing)
        return {
          runner,
          submissionId: existing.id,
          submission: existing.submission,
        };
    }
    const submissionId = this.deps.ids.ulid();
    const agentSession =
      sessionId === undefined
        ? undefined
        : {
            provider:
              attempt.agent === 'codex'
                ? ('codex' as const)
                : ('claude' as const),
            id: this.deps.redactor.maskSecrets(sessionId),
          };
    const command = {
      type: 'AcceptSubmission' as const,
      meta: {
        occurredAt: this.deps.clock.now().toISOString(),
        source: 'agent' as const,
      },
      attemptId: attempt.attemptId,
      submissionId,
      submission,
      ...(agentSession === undefined ? {} : { agentSession }),
    };
    const result = await runner.dispatch(command);
    if (!result.ok)
      return this.reject(
        located,
        result.error.code === 'gate_open' ? 'gate_open' : 'not_allowed',
        409,
      );
    return { runner, submissionId, submission };
  }
  private async reject(
    located: Located | undefined,
    reason: EventPayload<'submission.rejected'>['reason'],
    status: number,
  ): Promise<SubmissionResult> {
    const draft = {
      type: 'submission.rejected' as const,
      schemaVersion: CURRENT_SCHEMA_VERSION['submission.rejected'],
      occurredAt: this.deps.clock.now().toISOString(),
      source: 'agent' as const,
      provenance: 'decided' as const,
      workflowId: located?.runner.workflowId ?? null,
      ...(located ? { attemptId: located.attempt.attemptId } : {}),
      payload: {
        reason,
        ...(located ? { attemptId: located.attempt.attemptId } : {}),
      },
    };
    if (located) await located.runner.append([draft]);
    else this.deps.store.append([draft]);
    return { status, body: { error: reason } };
  }
  private async fail(
    error: unknown,
    located: Located | undefined,
  ): Promise<SubmissionResult> {
    const requestId = this.deps.ids.ulid();
    const info = toErrorInfo(error);
    const retryable = RETRYABLE.has(info.category);
    const scope = located
      ? {
          workflowId: located.runner.workflowId,
          attemptId: located.attempt.attemptId,
        }
      : {};
    // Never log the request body, headers or a non-port error's message.
    this.deps.logger.error(
      {
        requestId,
        ...scope,
        category: info.category,
        code: info.code,
        ...(error instanceof PortError
          ? { message: this.deps.redactor.maskSecrets(info.message) }
          : {}),
      },
      'agent submission failed',
    );
    if (located) {
      const id = located.attempt.attemptId;
      const streak = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, streak);
      if (streak === SUBMISSION_FAILURE_STREAK)
        await this.recordStreak(located, info.category, info.code, requestId);
    }
    const code = retryable ? 'submission_unavailable' : 'submission_failed';
    return {
      status: SUBMISSION_FAILURE_HTTP_STATUS[code],
      body: {
        error: {
          code,
          category: info.category,
          message: retryable
            ? 'The backend cannot process submissions right now.'
            : 'The backend failed to process this submission.',
          retryable,
          details: { requestId },
        },
      },
    };
  }
  /** Surfaces on the seat and workflow error lists instead of waiting for a stall. */
  private async recordStreak(
    located: Located,
    category: EventPayload<'error.recorded'>['category'],
    code: string,
    requestId: string,
  ): Promise<void> {
    try {
      await located.runner.append([
        {
          type: 'error.recorded',
          schemaVersion: CURRENT_SCHEMA_VERSION['error.recorded'],
          occurredAt: this.deps.clock.now().toISOString(),
          source: 'agent',
          provenance: 'decided',
          workflowId: located.runner.workflowId,
          attemptId: located.attempt.attemptId,
          payload: {
            category,
            code: 'submission_failed',
            message: `${SUBMISSION_FAILURE_STREAK} consecutive submissions from this attempt failed (${code})`,
            detail: `last requestId ${requestId}`,
          },
        },
      ]);
    } catch (error) {
      // The store may be what failed; the log line above still carries the request id.
      this.deps.logger.error(
        { requestId, code: toErrorInfo(error).code },
        'submission failure not recorded',
      );
    }
  }
  private response(body: SubmissionResponse): SubmissionResult {
    return { status: SUBMISSION_RESPONSE_HTTP_STATUS[body.status], body };
  }

  private mergeResult(accepted: Accepted): SubmissionResponse | undefined {
    if (accepted.submission.kind !== 'merge-request') return undefined;
    const events = this.deps.store.read({
      workflowId: accepted.runner.workflowId,
    });
    const source = events.find(
      (e) =>
        e.type === 'submission.accepted' &&
        e.payload.submissionId === accepted.submissionId,
    );
    if (!source) return undefined;
    const payload = accepted.submission.payload;
    const issued = events.find(
      (e) =>
        e.seq > source.seq &&
        e.type === 'command.issued' &&
        e.payload.kind === 'scm.mergePR' &&
        e.attemptId === source.attemptId &&
        e.payload.args.pr.number === payload.pr &&
        e.payload.args.expectedHeadSha === payload.expectedHeadSha,
    );
    if (issued?.type !== 'command.issued') return undefined;
    const outcome = events.find(
      (e) =>
        (e.type === 'command.succeeded' || e.type === 'command.failed') &&
        e.payload.commandId === issued.payload.commandId,
    );
    if (
      outcome?.type === 'command.succeeded' &&
      outcome.payload.kind === 'scm.mergePR'
    ) {
      return {
        status: 'merged',
        submissionId: accepted.submissionId,
        pr: payload.pr,
        mergeCommitSha: outcome.payload.result.mergeCommitSha,
      };
    }
    if (outcome?.type === 'command.failed') {
      const reason = MergeFailureReasonSchema.safeParse(
        outcome.payload.error.code,
      );
      return {
        status: 'failed',
        submissionId: accepted.submissionId,
        pr: payload.pr,
        reason: reason.success ? reason.data : 'guard',
        message: this.deps.redactor.maskSecrets(outcome.payload.error.message),
      };
    }
    return undefined;
  }
  private waitForMerge(accepted: Accepted): Promise<SubmissionResult> {
    const current = this.mergeResult(accepted);
    if (current) return Promise.resolve(this.response(current));
    if (this.closed)
      return Promise.resolve(
        this.response({
          status: 'pending',
          submissionId: accepted.submissionId,
        }),
      );
    return new Promise((resolve) => {
      const id = `${SUBMISSION_WAIT_PREFIX}${this.deps.ids.ulid()}`;
      const deadline = this.deps.clock.now().getTime() + 120_000;
      let unsubscribe = () => {};
      const finish = () => {
        unsubscribe();
        this.deps.scheduler.cancel(id);
        this.waits.delete(id);
        resolve(
          this.response(
            this.mergeResult(accepted) ?? {
              status: 'pending',
              submissionId: accepted.submissionId,
            },
          ),
        );
      };
      unsubscribe = this.deps.store.subscribe((event: DomainEvent) => {
        if (
          event.workflowId === accepted.runner.workflowId &&
          this.mergeResult(accepted)
        )
          finish();
      });
      this.waits.set(id, {
        workflowId: accepted.runner.workflowId,
        deadline,
        finish,
      });
      this.deps.scheduler.schedule({
        id,
        workflowId: accepted.runner.workflowId,
        fireAt: new Date(deadline).toISOString(),
      });
      if (this.mergeResult(accepted)) finish();
    });
  }
}
