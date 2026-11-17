import type { QuestionCommand } from '../commands.js';
import { notImplemented } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { WorkflowState } from '../state/index.js';

/** Placeholder: M1-T10 implements this partition. */
export const decideQuestion = (
  _state: WorkflowState,
  command: QuestionCommand,
): DecideResult => notImplemented(command.type);
