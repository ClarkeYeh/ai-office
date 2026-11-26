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

// Injective (FX-TAIL): `%` itself is escaped, and whitespace above U+00FF
// becomes its UTF-8 bytes (`%E2%80%A8`), never four hex digits that read
// like `%20` plus two literal characters. Every other id is unchanged.
const markerSafe = (part: string): string =>
  part.replace(/[\s<>%]/g, (c) =>
    c.charCodeAt(0) > 0xff
      ? encodeURIComponent(c)
      : `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );

/**
 * Deterministic command id: `<workflowId>/<part>/<part>…`. Command ids become
 * external markers (Orca `aio:`, GitHub `<!-- ai-office:cmd= -->`), whose
 * guards refuse whitespace and `<>`, so any such character in a part (and
 * `%`, keeping distinct parts distinct) is percent-encoded rather than left to
 * fail at the runtime.
 */
export const commandId = (
  ctx: Pick<ReactContext, 'workflowId'>,
  ...parts: (string | number)[]
): string =>
  [ctx.workflowId, ...parts.map((part) => markerSafe(String(part)))].join('/');

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
