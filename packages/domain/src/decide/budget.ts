import type { BudgetCommand } from '../commands.js';
import { notImplemented } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { WorkflowState } from '../state/index.js';

/** Placeholder: M1-T10 implements this partition. */
export const decideBudget = (
  _state: WorkflowState,
  command: BudgetCommand,
): DecideResult => notImplemented(command.type);
