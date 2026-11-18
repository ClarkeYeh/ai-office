import type { Attempt } from '@ai-office/domain';
import { commandId } from './context.js';
import type { ReactContext } from './context.js';
import { external } from './effects.js';
import type { ExternalEffect } from './effects.js';

/** Deterministic `runtime.stop`; `[]` while the spawn has not reported its agent ref. */
export const stopAttempt = (
  ctx: ReactContext,
  attempt: Attempt,
  ...tag: (string | number)[]
): ExternalEffect[] =>
  attempt.agentRef === undefined
    ? []
    : [
        external(
          commandId(ctx, 'stop', attempt.attemptId, ...tag),
          { kind: 'runtime.stop', args: { agent: attempt.agentRef } },
          { stageId: attempt.stageId, attemptId: attempt.attemptId },
        ),
      ];

/** Deterministic `runtime.release`; its success is recorded as `seat.released`. */
export const releaseAttempt = (
  ctx: ReactContext,
  attempt: Attempt,
  removeWorkspace: boolean,
  ...tag: (string | number)[]
): ExternalEffect[] =>
  attempt.agentRef === undefined
    ? []
    : [
        external(
          commandId(ctx, 'release', attempt.attemptId, ...tag),
          {
            kind: 'runtime.release',
            args: { agent: attempt.agentRef, removeWorkspace },
          },
          { stageId: attempt.stageId, attemptId: attempt.attemptId },
        ),
      ];
