import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeScenario } from '../adapters/runtime-fake/index.js';
import { mainlineScenario } from '../adapters/runtime-fake/mainline.js';
import { closeAll, isEnded, office } from './test-support/harness.js';
import type { Json } from './test-support/harness.js';

/*
 * M2-FX12 (live implement runs #3 and #4): on real Orca a stopped agent is
 * observed `exited` about 2 s before its release succeeds. §8.1 holds only if
 * no stage gate opens until every seat is released, not merely exited.
 */
afterEach(closeAll);

const laggingReleases: RuntimeScenario = {
  ...mainlineScenario,
  roles: Object.fromEntries(
    Object.entries(mainlineScenario.roles).map(([role, behavior]) => [
      role,
      { ...behavior, releaseLagMs: 300 },
    ]),
  ),
};

/** Attempts spawned but not yet released when each stage gate opened. */
const unreleasedAtStageGates = (events: Json[]) => {
  const open = new Set<string>();
  const result: { gateId: string; unreleased: string[] }[] = [];
  for (const event of events) {
    if (event.type === 'seat.spawned') open.add(event.payload.attemptId);
    if (event.type === 'seat.released') open.delete(event.payload.attemptId);
    if (event.type === 'gate.opened' && event.payload.kind === 'stage')
      result.push({ gateId: event.payload.gateId, unreleased: [...open] });
  }
  return result;
};

describe(
  'M2-FX12: a release that lags the exit (composed fake)',
  { timeout: 60_000 },
  () => {
    it('opens every stage gate only after every seat is released', async () => {
      const o = await office({ scenario: laggingReleases });
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded, { timeoutMs: 20_000 });
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      const gates = unreleasedAtStageGates(events);
      expect(gates.length).toBeGreaterThan(0);
      expect(gates).toEqual(gates.map((g) => ({ ...g, unreleased: [] })));
      // The lag was real: some seat exited before its release landed.
      const exitedAt = new Map<string, number>();
      let lagged = false;
      for (const e of events) {
        if (e.type === 'seat.exited') exitedAt.set(e.payload.attemptId, e.seq);
        if (e.type === 'seat.released' && exitedAt.has(e.payload.attemptId))
          lagged = true;
      }
      expect(lagged).toBe(true);
    });
  },
);
