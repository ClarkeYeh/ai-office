import { FAKE_REPO } from '../../../main.js';
import { checkpoints } from './test-support/checkpoints.js';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  office,
  closeAll,
  tempHome,
  isEnded,
  until,
  sleep,
} from '../../../acceptance/test-support/harness.js';
import { webScenario } from './index.js';
// The recorder lives outside production code; Vitest resolves the harness's TS graph.
import { normalizeEvents } from '../../../../../../scripts/record-web-fixtures/normalize.mjs';

afterEach(closeAll);
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
    const o = await office({ home, scenario: webScenario(name, 40) });
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
            await sleep(150);
            return { decision: 'approve' };
          },
        },
      );
      await sleep(1000);
      await o.server.runners.idle();
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
    // Drain scheduled observations at the selected milestone before taking a page.
    await sleep(name === 'load-10' ? 4000 : name === 'trouble' ? 1200 : 250);
    await o.server.runners.idle();
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
