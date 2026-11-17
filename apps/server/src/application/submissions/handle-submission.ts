import {
  AgentSubmissionSchema,
  MergeFailureReasonSchema,
  SubmissionHeadersSchema,
  SUBMISSION_RESPONSE_HTTP_STATUS,
} from '@ai-office/contracts/agent-submission';
import type {
  AgentSubmission,
  SubmissionResponse,
} from '@ai-office/contracts/agent-submission';
import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type { DomainEvent, EventPayload } from '@ai-office/contracts/events';
import type { Attempt } from '@ai-office/domain';
import type { RuntimePort } from '../../ports/runtime.js';
import type {
  Clock,
  IdGen,
  Redactor,
  ScheduledTimer,
  Scheduler,
} from '../../ports/services.js';
import type { EventStore, SeatTokenStore } from '../../ports/stores.js';
import type { WorkflowRunners } from '../runner/runners.js';
import type { WorkflowRunner } from '../runner/workflow-runner.js';

export type SubmissionResult = {
  status: number;
  body:
    | SubmissionResponse
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
}
type Located = { runner: WorkflowRunner; attempt: Attempt };
type Accepted = {
  runner: WorkflowRunner;
  submissionId: string;
  submission: AgentSubmission;
};
export const SUBMISSION_WAIT_PREFIX = 'submission-wait/';

/** Gateway use case. Wire scheduler deliveries to onTimer before runners.onTimer. */
export class HandleSubmission {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly waits = new Map<
    string,
    { workflowId: string; deadline: number; finish: () => void }
  >();
  constructor(private readonly deps: HandleSubmissionDeps) {}

  async handle(headers: unknown, body: unknown): Promise<SubmissionResult> {
    const parsed = SubmissionHeadersSchema.safeParse(headers);
    if (!parsed.success)
      return this.reject(undefined, 'identity_mismatch', 401);
    const h = parsed.data;
    const token = h.authorization.slice('Bearer '.length);
    const attemptId = this.deps.seatTokens.verify(token);
    const located = attemptId === null ? undefined : this.locate(attemptId);
    if (!located) return this.reject(undefined, 'identity_mismatch', 401);
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
      const existing = Object.values(runner.state.submissions).find(
        (record) => {
          const old = record.submission;
          return (
            record.attemptId === attempt.attemptId &&
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
