import type { ExternalCommand } from '@ai-office/contracts/events';
import type {
  AgentKind,
  SpecRequest,
  DomainCommand,
  TimerPayload,
} from '@ai-office/domain';

/**
 * A runtime/scm side effect (§11.4). `commandId` is chosen by engine and is
 * deterministic, so replaying the same events issues the same ids (§11.5:
 * `orcaRequestId = UUIDv5(commandId)`) and engine can tell from
 * `state.commands` whether it already issued a command. `stageId` /
 * `attemptId` land on the `command.issued` envelope.
 */
export interface ExternalEffect {
  kind: 'external';
  commandId: string;
  command: ExternalCommand;
  stageId?: string;
  attemptId?: string;
}

/** A domain command fed back into the workflow's input queue (§11.4). */
export interface InternalEffect {
  kind: 'internal';
  command: DomainCommand;
}

export interface TimerSpec {
  id: string;
  fireAt: string;
  payload: TimerPayload;
}

/** Written as `timer.scheduled`; the Scheduler later reports `timer.fired`. */
export interface TimerEffect {
  kind: 'timer';
  timer: TimerSpec;
}

/** Written as `timer.cancelled` when the timer is still pending. */
export interface CancelTimerEffect {
  kind: 'cancelTimer';
  id: string;
  reason?: string;
}

/** Application materializes the spec and token before writing command.issued. */
export interface SpawnEffect {
  kind: 'spawn';
  commandId: string;
  stageId: string;
  seatId: string;
  attemptId: string;
  spec: SpecRequest;
  agent: AgentKind;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  title?: string;
  workspace: Extract<
    ExternalCommand,
    { kind: 'runtime.spawnAgent' }
  >['args']['workspace'];
  keepOpen: boolean;
}

export type Effect =
  | SpawnEffect
  | ExternalEffect
  | InternalEffect
  | TimerEffect
  | CancelTimerEffect;

export const external = (
  commandId: string,
  command: ExternalCommand,
  scope: { stageId?: string | undefined; attemptId?: string | undefined } = {},
): ExternalEffect => ({
  kind: 'external',
  commandId,
  command,
  ...(scope.stageId === undefined ? {} : { stageId: scope.stageId }),
  ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
});

export const internal = (command: DomainCommand): InternalEffect => ({
  kind: 'internal',
  command,
});
