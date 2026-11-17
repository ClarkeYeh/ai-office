import type { ExternalCommand } from '@ai-office/contracts/events';
import type { AgentKind, SpecRequest } from '@ai-office/domain';

type SpawnArgs = Extract<
  ExternalCommand,
  { kind: 'runtime.spawnAgent' }
>['args'];

/**
 * Spawn intent (coordinator ruling for T13/T23). Engine cannot write spec files
 * or hold seat tokens, so it emits this instead of a concrete
 * `runtime.spawnAgent`; the runner materializes it into fully concrete args
 * (§11.5, N3). Engine emits the `SpawnAttempt` command (same `commandId` as
 * `spawnCommandId`) earlier in the same react batch.
 *
 * Local copy until T13 adds the identical variant to `@ai-office/engine`'s
 * `Effect` union; then this module should re-export the engine type.
 */
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
  /** Fully concrete; names and branches are engine's (N2), never the runner's. */
  workspace: SpawnArgs['workspace'];
  keepOpen: boolean;
}
