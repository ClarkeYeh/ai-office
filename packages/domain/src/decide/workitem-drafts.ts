import type { WorkItemDraftCommand } from '../commands.js';
import { notImplemented } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { WorkflowState } from '../state/index.js';

/** Placeholder: M1-T9 implements this partition. */
export const decideWorkItemDrafts = (
  _state: WorkflowState,
  command: WorkItemDraftCommand,
): DecideResult => notImplemented(command.type);
