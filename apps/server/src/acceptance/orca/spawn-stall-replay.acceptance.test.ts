import { afterEach, describe, expect, it } from 'vitest';
import { orcaReplayFixture } from '../../test-support/orca/contract-binding.js';
import type { RuntimeEvent } from '../../ports/runtime-events.js';
import type { RuntimeCursor } from '../../ports/refs.js';

/*
 * M2-T17 spawn-stall acceptance (b), CI: runtime-orca over the T9 synthetic
 * Orca wire world (no subprocess). A spawned worker that worker-list keeps
 * reporting as working, with no mailbox message and no transcript output, must
 * make the adapter emit no activity, no error/lost status and no exit for two
 * full default spawn-stall periods — so only the engine's stall rule (case a)
 * can react. `main.ts` has no exec seam in orca mode (T10), so the engine half
 * runs composed in case (a) instead of over this replay.
 */
let dispose: (() => void | Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const SPAWN_STALL_MS = 600_000;

describe('M2-T17 spawn stall (b): runtime-orca synthetic replay', () => {
  it('stays silent for a working worker with no output over 2× spawnStallMs', async () => {
    const f = await orcaReplayFixture();
    dispose = f.dispose;
    const agent = await f.runtime.spawnAgent(f.spawnRequest);
    const seen: RuntimeEvent[] = [];
    let cursor: RuntimeCursor | null = null;
    for (let elapsed = 0; elapsed <= 2 * SPAWN_STALL_MS; elapsed += 30_000) {
      const batch = await f.runtime.observe(f.session, cursor);
      seen.push(...batch.events);
      cursor = batch.cursor;
      f.advance(30_000);
    }
    const mine = seen.filter((e) => 'agent' in e && e.agent === agent);
    // Not vacuous: the worker was observed (status only) on every poll cycle.
    expect(new Set(mine.map((e) => e.type))).toEqual(new Set(['agent.status']));
    expect(f.world.calls.length).toBeGreaterThan(40);
    expect(mine.map((e) => e.type)).not.toContain('agent.output');
    expect(mine.map((e) => e.type)).not.toContain('agent.exited');
    expect(mine.map((e) => e.type)).not.toContain('agent.question');
    expect(
      mine.filter(
        (e) =>
          e.type === 'agent.status' &&
          ['error', 'lost', 'exited'].includes(
            (e as { status?: string }).status ?? '',
          ),
      ),
    ).toEqual([]);
    // The adapter still observes the worker as live the whole time.
    const workers = f.world.workers.filter((w) => w.dispatchId === agent);
    expect(workers.map((w) => [w.activity, w.terminalState])).toEqual([
      ['working', 'retained'],
    ]);
  });
});
