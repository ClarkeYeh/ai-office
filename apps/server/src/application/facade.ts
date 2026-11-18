import type { WorkflowRunners } from './runner/runners.js';
import { CommandUseCases } from './use-cases/commands.js';
import type { CommandUseCaseDeps } from './use-cases/commands.js';
export type {
  StartWorkflowInput,
  GateDecisionInput,
  AnswerInput,
  CommandUseCaseDeps,
} from './use-cases/commands.js';
export { UseCaseError } from './use-cases/support.js';

export interface ApplicationFacade extends Pick<
  CommandUseCases,
  | 'startWorkflow'
  | 'decideGate'
  | 'answerQuestion'
  | 'cancelWorkflow'
  | 'cleanupWorkflow'
  | 'messageSeat'
  | 'registerRepo'
> {
  readonly runners: WorkflowRunners;
  // --- T28: HandleSubmission
}

/** T33 supplies ports; inbound adapters depend only on this facade. */
export const createCommandFacade = (
  deps: CommandUseCaseDeps,
): ApplicationFacade => {
  const commands = new CommandUseCases(deps);
  return {
    runners: deps.runners,
    startWorkflow: commands.startWorkflow.bind(commands),
    decideGate: commands.decideGate.bind(commands),
    answerQuestion: commands.answerQuestion.bind(commands),
    cancelWorkflow: commands.cancelWorkflow.bind(commands),
    cleanupWorkflow: commands.cleanupWorkflow.bind(commands),
    messageSeat: commands.messageSeat.bind(commands),
    registerRepo: commands.registerRepo.bind(commands),
  };
};
