import type { WorkflowRunners } from './runner/runners.js';

/**
 * What api / agent-gateway see of application (§23). Type skeleton only (plan
 * §5.1): T27 adds the command use cases and T28 HandleSubmission, each in its
 * own section below; main.ts (T33) builds the implementation.
 */
export interface ApplicationFacade {
  /** Per-workflow actors and the global workflow slot (T23). */
  readonly runners: WorkflowRunners;
  // --- T27: command use cases (StartWorkflow, DecideGate, AnswerQuestion, …)
  // --- T28: HandleSubmission
}
