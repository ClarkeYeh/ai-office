import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type {
  DomainEventDraft,
  EventPayload,
  EventType,
} from '@ai-office/contracts/events';
import type { CommandMeta } from '../commands.js';
import { domainError } from '../errors.js';
import type { DecideResult, DomainError } from '../errors.js';
import type { Workflow, WorkflowState } from '../state/index.js';

export interface EventScope {
  workflowId: string;
  stageId?: string | undefined;
  seatId?: string | undefined;
  attemptId?: string | undefined;
}

/** Builds an event draft; EventStore later assigns `seq`, `id`, `recordedAt`. */
export const draft = <T extends EventType>(
  meta: CommandMeta,
  scope: EventScope,
  type: T,
  payload: EventPayload<T>,
): DomainEventDraft => {
  const provenance =
    meta.provenance ??
    (meta.source === 'runtime' || meta.source === 'scm'
      ? 'observed'
      : 'decided');
  return {
    type,
    payload,
    occurredAt: meta.occurredAt,
    workflowId: scope.workflowId,
    ...(scope.stageId === undefined ? {} : { stageId: scope.stageId }),
    ...(scope.seatId === undefined ? {} : { seatId: scope.seatId }),
    ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
    source: meta.source,
    provenance,
    schemaVersion: CURRENT_SCHEMA_VERSION[type],
    ...(meta.externalKey === undefined
      ? {}
      : { externalKey: meta.externalKey }),
    ...(meta.causationId === undefined
      ? {}
      : { causationId: meta.causationId }),
  } as DomainEventDraft;
};

export const isDomainError = (value: unknown): value is DomainError =>
  typeof value === 'object' &&
  value !== null &&
  'category' in value &&
  'code' in value;

export const failed = (error: DomainError): DecideResult => ({
  ok: false,
  error,
});

export interface RunningOptions {
  /** New work (stages, attempts) is refused while paused or cancelling. */
  dispatch?: boolean;
}

/** The started, non-terminal workflow, or the error explaining why not. */
export const runningWorkflow = (
  state: WorkflowState,
  options: RunningOptions = {},
): Workflow | DomainError => {
  const workflow = state.workflow;
  if (workflow === null)
    return domainError(
      'conflict',
      'workflow_not_started',
      'Workflow has not started',
    );
  if (workflow.status !== 'running')
    return domainError(
      'conflict',
      'workflow_ended',
      `Workflow is ${workflow.status}`,
      {
        status: workflow.status,
      },
    );
  if (options.dispatch === true) {
    if (workflow.cancelRequested)
      return domainError(
        'conflict',
        'cancel_requested',
        'Workflow is being cancelled',
      );
    if (workflow.pausedReasons.length > 0)
      return domainError('conflict', 'workflow_paused', 'Workflow is paused', {
        reasons: workflow.pausedReasons,
      });
  }
  return workflow;
};

/** Copies only defined optional fields (exactOptionalPropertyTypes). */
export const defined = <T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
