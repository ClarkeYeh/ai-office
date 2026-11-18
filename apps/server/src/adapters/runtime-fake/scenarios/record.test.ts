import { FAKE_REPO } from '../../../main.js';
import type { FakeWorld } from '../../../main.js';
import { checkpoints } from './test-support/checkpoints.js';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  acceptanceWorld,
  office,
  closeAll,
  tempHome,
  isEnded,
  until,
} from '../../../acceptance/test-support/harness.js';
import type { Office } from '../../../acceptance/test-support/harness.js';
import { webScenario } from './index.js';
// The recorder lives outside production code; Vitest resolves the harness's TS graph.
import { normalizeEvents } from '../../../../../../scripts/record-web-fixtures/normalize.mjs';

afterEach(closeAll);

/** Counts completed observation reads, so draining waits for whole passes. */
function countReads(world: FakeWorld) {
  const reads = { runtime: 0, scm: 0 };
  const runtime = world.runtime;
  const observe = runtime.observe.bind(runtime);
  runtime.observe = (...args) =>
    observe(...args).finally(() => reads.runtime++);
  const scm = world.scm;
  const poll = scm.poll.bind(scm);
  scm.poll = (...args) => poll(...args).finally(() => reads.scm++);
  return reads;
}

/**
 * Drains the fake world instead of sleeping: no agent step is left to run,
 * commands are idle, and two further complete runtime and SCM observation
 * passes (the first may have started before the last change) add no event,
 * or the workflow has ended. Unlike a sleep, this is the same point however
 * slowly the machine runs.
 */
async function settle(
  o: Office,
  id: string,
  reads: ReturnType<typeof countReads>,
) {
  let seq = -1;
  let since = { ...reads };
  await until(
    async () => {
      await o.server.runners.idle();
      const model = await o.readModel(id);
      // Observation stops with the workflow; nothing more can arrive.
      if (isEnded(model)) return true;
      const last = model.lastSeq as number;
      if (o.world.runtime.pendingSteps() > 0 || last !== seq) {
        seq = last;
        since = { ...reads };
        return false;
      }
      return reads.runtime >= since.runtime + 2 && reads.scm >= since.scm + 2;
    },
    Boolean,
    'the fake world to settle',
    55_000,
  );
}

const root = resolve(import.meta.dirname, '../../../../../..');
it
  .skipIf(!process.env.AIO_WEB_FIXTURES)
  .each(['demo', 'parallel', 'trouble', 'load-10', 'stall'] as const)(
  'records %s via the acceptance harness',
  { timeout: 60_000 },
  async (name) => {
    const home = tempHome();
    mkdirSync(join(home, 'templates'), { recursive: true });
    copyFileSync(
      join(root, `fixtures/web/templates/${name}.yaml`),
      join(home, `templates/${name}.yaml`),
    );
    const world = acceptanceWorld(home, webScenario(name, 40));
    const reads = countReads(world);
    const o = await office({ home, world });
    const id = await o.start({ templateId: name });
    if (name === 'demo' || name === 'parallel') {
      await o.drive(
        id,
        async () =>
          (await o.gates(id)).some(
            (g) => g.stageKind === 'final-pr' && g.status === 'open',
          ),
        {
          mergeFinalPr: false,
          timeoutMs: 55_000,
          policy: async () => {
            await settle(o, id, reads);
            return { decision: 'approve' };
          },
        },
      );
      await settle(o, id, reads);
      await o.world.scm.mergeOwner({
        repo: FAKE_REPO.github,
        number: o.server.runners.get(id)!.state.workflow!.finalPr!,
      });
      await until(() => o.readModel(id), isEnded, 'explicit final merge');
    } else
      await o.drive(
        id,
        async (model) =>
          name === 'trouble'
            ? (await o.gates(id)).some((g) => g.kind === 'exception')
            : model.workItems.some(
                (item: { status: string }) => item.status === 'in_progress',
              ),
        { timeoutMs: 55_000, onException: () => true },
      );
    // Drain at the selected milestone before taking a page.
    await settle(o, id, reads);
    const events = normalizeEvents(await o.events(id));
    const actual = checkpoints(events);
    const text = JSON.stringify(events, null, 2) + '\n';
    const path = join(root, `fixtures/web/${name}.events.json`);
    if (process.env.AIO_WEB_FIXTURES === '--record') writeFileSync(path, text);
    else
      expect(
        actual,
        'Fixture changed: run pnpm fixtures:web --record to re-record after convergence',
      ).toEqual(checkpoints(JSON.parse(readFileSync(path, 'utf8'))));
  },
);
