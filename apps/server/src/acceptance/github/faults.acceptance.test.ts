import { afterEach, describe, expect, it } from 'vitest';
import { fakeBinding } from './test-support/fake-binding.js';
import { mixedOffice, type MixedOffice } from './test-support/mixed-office.js';
import { runFaults } from './test-support/scenario.js';

let office: MixedOffice | undefined;
afterEach(async () => {
  await office?.close();
  office = undefined;
});

/*
 * M3-T15 step 12, CI: fault injection through the composed mixed server. The
 * live twin (`faults.github.test.ts`) injects the same faults below scm-github
 * on the spike, once; the adapter-level lost-response replay is the shared
 * T8 contract case.
 */
describe('M3-T15 step 12 fault injection (CI)', { timeout: 120_000 }, () => {
  it('keeps one Issue after a lost create; cancel reaches the runtime while the SCM breaker is open', async () => {
    office = await mixedOffice(fakeBinding());
    const run = await runFaults(office);
    expect(run.steps.map((s) => [s.title, s.ok])).toEqual([
      ['lost createIssue response + list lag → one conclusion Issue', true],
      ['SCM breaker open: cancel still sends runtime stop/release', true],
    ]);
  });
});
