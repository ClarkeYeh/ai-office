import type { DomainEvent } from '@ai-office/contracts/events';
import type { CommandMeta, Timer, WorkflowState } from '@ai-office/domain';

/**
 * What every engine module sees for one stored event. `before` is the state
 * the event was applied to and `state` the state after it; `timer` is the
 * timer that fired (its payload is gone from `state.timers` once fired).
 */
export interface ReactContext {
  workflowId: string;
  event: DomainEvent;
  before: WorkflowState;
  state: WorkflowState;
  timer?: Timer;
}

/** Meta for internal commands: the triggering event's time, never a clock (§4). */
export const metaFor = (ctx: ReactContext): CommandMeta => ({
  occurredAt: ctx.event.occurredAt,
  source: 'engine',
  causationId: ctx.event.id,
});

/** Deterministic command id: `<workflowId>/<part>/<part>…`. */
export const commandId = (
  ctx: Pick<ReactContext, 'workflowId'>,
  ...parts: (string | number)[]
): string => [ctx.workflowId, ...parts].join('/');

/** The Orca session opened at workflow start, once its command succeeded. */
export const sessionRef = (state: WorkflowState): string | undefined => {
  for (const record of Object.values(state.commands)) {
    const result = record.result?.result;
    if (
      record.result?.kind === 'runtime.openSession' &&
      result !== undefined &&
      result !== null &&
      'session' in result
    )
      return result.session;
  }
  return undefined;
};
