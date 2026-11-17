import type { DomainEvent } from '@ai-office/contracts/events';
import { domainError } from '@ai-office/domain';
import type { DomainCommand, StartWorkflow } from '@ai-office/domain';
import type { ScheduledTimer } from '../../ports/services.js';
import { RETRY_TIMER_PREFIX } from '../commands/executor.js';
import { WorkflowRunner } from './workflow-runner.js';
import type { DispatchResult, WorkflowRunnerDeps } from './workflow-runner.js';

/**
 * All WorkflowRunners of this process. Owns the cross-workflow rules: the
 * single workflow slot checked when starting (global serialization), routing
 * Scheduler deliveries, and rebuilding runners from events on restart.
 */
export class WorkflowRunners {
  private readonly runners = new Map<string, WorkflowRunner>();
  private starting: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WorkflowRunnerDeps) {}

  /** Restart: one runner per workflow in the store, timers re-armed. */
  recover(): void {
    const byWorkflow = new Map<string, DomainEvent[]>();
    for (const event of this.deps.store.read({})) {
      if (event.workflowId === null) continue;
      const events = byWorkflow.get(event.workflowId) ?? [];
      events.push(event);
      byWorkflow.set(event.workflowId, events);
    }
    for (const [workflowId, events] of byWorkflow)
      if (!this.runners.has(workflowId))
        this.runners.set(
          workflowId,
          WorkflowRunner.restore(workflowId, this.deps, events),
        );
  }

  get(workflowId: string): WorkflowRunner | undefined {
    return this.runners.get(workflowId);
  }

  all(): WorkflowRunner[] {
    return [...this.runners.values()];
  }

  /** The running workflow holding the global slot, if any (§16.3). */
  active(): WorkflowRunner | undefined {
    return this.all().find(
      (runner) => runner.state.workflow?.status === 'running',
    );
  }

  /**
   * StartWorkflow is serialized across all workflows: the slot check and the
   * start happen in one step, so two concurrent starts cannot both win.
   */
  start(command: StartWorkflow): Promise<DispatchResult> {
    const run = this.starting.then(async (): Promise<DispatchResult> => {
      const busy = this.active();
      if (busy !== undefined)
        return {
          ok: false,
          error: domainError(
            'conflict',
            'workflow_slot_busy',
            `Workflow ${busy.workflowId} is still running`,
            { workflowId: busy.workflowId },
          ),
        };
      const existing = this.runners.get(command.workflowId);
      const runner =
        existing ?? new WorkflowRunner(command.workflowId, this.deps);
      const result = await runner.dispatch(command);
      if (result.ok && existing === undefined)
        this.runners.set(command.workflowId, runner);
      return result;
    });
    this.starting = run.catch(() => undefined);
    return run;
  }

  /** Any other command goes to its workflow's queue. */
  dispatch(
    workflowId: string,
    command: DomainCommand,
  ): Promise<DispatchResult> {
    const runner = this.runners.get(workflowId);
    if (runner === undefined)
      return Promise.resolve({
        ok: false,
        error: domainError(
          'validation',
          'unknown_workflow',
          `No workflow ${workflowId}`,
        ),
      });
    return runner.dispatch(command);
  }

  /** The Scheduler's sink: retry backoffs to the executor, the rest to runners. */
  onTimer(timer: ScheduledTimer): void {
    if (timer.id.startsWith(RETRY_TIMER_PREFIX)) {
      this.deps.executor.wake(timer.id);
      return;
    }
    this.runners.get(timer.workflowId)?.fireTimer(timer.id);
  }

  /** Resolves once every runner is idle at the same time. */
  async idle(): Promise<void> {
    // A command result may re-enter a runner that was already waited for.
    while (this.all().some((runner) => runner.busy))
      await Promise.all(this.all().map((runner) => runner.idle()));
  }
}
