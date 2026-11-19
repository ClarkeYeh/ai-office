import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openHarness, assertClean } from './harness.js';
import { marker, LABEL } from './safety.js';

/** Fixed scenario registry; never dynamically import user-supplied code. */
export async function runHarnessCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'record') {
    if (rest.length !== 1 || rest[0] !== 'smoke')
      throw new Error('Expected record smoke');
    const harness = await openHarness({ record: true });
    try {
      try {
        await harness.ensureLabel();
        const id = harness.ledger.data.runId;
        await harness.api.request('POST', '/issues', {
          title: `[aio-test ${id}] harness smoke`,
          body: `Synthetic harness smoke\n${marker(`t${id}:smoke`)}`,
          labels: [LABEL],
        });
      } finally {
        const result = await harness.cleanup();
        console.info(
          JSON.stringify({
            leftovers: result.leftovers,
            scan: result.scan,
            calls: harness.gate.calls,
          }),
        );
        if (
          result.leftovers ||
          result.scan.openObjects.length ||
          result.scan.branches.length
        )
          assertClean(result);
      }
      const path = resolve('fixtures/github/2022-11-28/harness-smoke.json');
      await mkdir(dirname(path), { recursive: true });
      await harness.recorder!.save(path);
    } finally {
      await harness.close();
    }
    return;
  }
  if (command === 'janitor') {
    if (
      rest[0] !== '--ledger' ||
      !rest[1] ||
      rest.slice(2).some((x) => !['--apply', '--scan'].includes(x))
    )
      throw new Error('Expected janitor --ledger <path> [--apply] [--scan]');
    const harness = await openHarness({
      ledgerPath: resolve(rest[1]),
      recover: true,
    });
    try {
      const result = await harness.cleanup(rest.includes('--apply'));
      console.info(JSON.stringify(result));
      if (
        rest.includes('--apply') &&
        (result.leftovers ||
          result.scan.openObjects.length ||
          result.scan.branches.length)
      )
        throw new Error('Cleanup incomplete');
    } finally {
      await harness.close();
    }
    return;
  }
  throw new Error('Unknown GitHub harness command');
}
