import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ScmEventSchema } from '../../ports/scm-events.js';
import { assembleContractScm } from './test-support/assembly.js';
import {
  ReplayFetch,
  type Recording,
} from '../../test-support/github/recording.js';
import {
  expectedObservation,
  externalMergeScenario,
  externalMergeTape,
} from '../../test-support/github/external-merge.js';

it('replays the observed owner hand-merge of spike PR #144: getPR, then poll reports pr.state merged and main moving', async () => {
  const rows = JSON.parse(
    await readFile(externalMergeTape, 'utf8'),
  ) as Recording[];
  expect(rows.every((row) => row.method === 'GET')).toBe(true);
  const replay = new ReplayFetch(rows);
  const observed = await externalMergeScenario(
    replay.fetch,
    assembleContractScm,
  );
  replay.assertConsumed();
  const expected = expectedObservation();
  expect(observed.pr).toEqual(expected.pr);
  expect(observed.events).toMatchObject(expected.events);
  expect(observed.events).toHaveLength(expected.events.length);
  for (const event of observed.events)
    expect(ScmEventSchema.safeParse(event).success).toBe(true);
});
