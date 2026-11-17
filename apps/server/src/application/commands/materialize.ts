import type { ExternalCommand } from '@ai-office/contracts/events';
import { buildSpec, domainError } from '@ai-office/domain';
import type { DomainError, WorkflowState } from '@ai-office/domain';
import { sessionRef } from '@ai-office/engine';
import { PortError } from '../../ports/errors.js';
import type { SeatTokenStore, SpecStore } from '../../ports/stores.js';
import type { SpawnEffect } from '@ai-office/engine';

export interface SpawnMaterializerDeps {
  /** Only restore may rotate a token whose spawn was never issued. */
  recoverUnissued?: boolean;
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
 * its path and sha256. Finishes before the first issuance of a commandId, at
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
    // Recovery may replace an unexposed token; the store checks the durable ledger.
    if (!(error instanceof PortError) || error.category !== 'conflict')
      throw error;
    if (!deps.recoverUnissued || state.commands[effect.commandId])
      return bug('seat_token_reissue', 'Spawn command already issued', effect);
    try {
      seatToken = deps.seatTokens.rotateUnissued(effect.attemptId);
    } catch (rotationError) {
      if (
        rotationError instanceof PortError &&
        rotationError.category === 'conflict'
      )
        return bug(
          'seat_token_reissue',
          'Spawn token cannot be rotated',
          effect,
        );
      throw rotationError;
    }
    deps.specStore.removeUnissued(effect.attemptId);
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
