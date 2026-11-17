import type { ExternalCommand } from '@ai-office/contracts/events';
import { buildSpec, domainError } from '@ai-office/domain';
import type { DomainError, WorkflowState } from '@ai-office/domain';
import { sessionRef } from '@ai-office/engine';
import { PortError } from '../../ports/errors.js';
import type { SeatTokenStore, SpecStore } from '../../ports/stores.js';
import type { SpawnEffect } from './spawn-effect.js';

export interface SpawnMaterializerDeps {
  seatTokens: SeatTokenStore;
  specStore: SpecStore;
  /** `<installDir>/apps/cli/dist/main.js` (Q8). */
  cliPath: string;
}

const bug = (code: string, message: string, effect: SpawnEffect) =>
  domainError('bug', code, message, {
    commandId: effect.commandId,
    attemptId: effect.attemptId,
  });

/**
 * Turns a spawn intent into a fully concrete `runtime.spawnAgent` (§11.5, N3):
 * seat token (once per attempt) → SpecBuilder → spec file (0600) → args with
 * its path and sha256. Runs exactly once per commandId, right before
 * `command.issued`; retries and reconcile reuse the recorded args.
 */
export const materializeSpawn = (
  state: WorkflowState,
  effect: SpawnEffect,
  deps: SpawnMaterializerDeps,
): ExternalCommand | DomainError => {
  const attempt = state.attempts[effect.attemptId];
  if (attempt?.spawnCommandId !== effect.commandId)
    return bug(
      'spawn_without_attempt',
      `No attempt ${effect.attemptId} recorded for ${effect.commandId}`,
      effect,
    );
  const session = sessionRef(state);
  if (session === undefined)
    return bug('no_session', 'Spawn before the Orca session opened', effect);
  let seatToken: string;
  try {
    seatToken = deps.seatTokens.issue(effect.attemptId);
  } catch (error) {
    // A second issue means a token may already be in a spec: never mint another.
    if (error instanceof PortError && error.category === 'conflict')
      return bug(
        'seat_token_reissue',
        `Seat token for ${effect.attemptId} was already issued`,
        effect,
      );
    throw error;
  }
  const spec = buildSpec(state, effect.spec, {
    cliPath: deps.cliPath,
    seatToken,
  });
  if ('category' in spec) {
    deps.seatTokens.revoke(effect.attemptId);
    return spec;
  }
  const file = deps.specStore.write(effect.attemptId, spec.text);
  return {
    kind: 'runtime.spawnAgent',
    args: {
      session,
      agent: effect.agent,
      ...(effect.model === undefined ? {} : { model: effect.model }),
      ...(effect.effort === undefined ? {} : { effort: effect.effort }),
      title: effect.title ?? `aio:${effect.commandId}`,
      specPath: file.path,
      specSha256: file.sha256,
      workspace: effect.workspace,
      keepOpen: effect.keepOpen,
    },
  };
};
