import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { createRedactor } from '@ai-office/redaction';
import type { ScmPort } from '../../ports/scm.js';
import type { Clock } from '../../ports/services.js';
export type GithubBindingFactory = (options: {
  fetch: typeof globalThis.fetch;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  registeredAt: () => string;
}) => ScmPort;
import {
  scmPortContract,
  type ScmContractFixture,
} from '../scm-port-contract.js';
import { openHarness, assertClean } from './harness.js';
import { GitPusher } from './pusher.js';
import { RecordingFetch, ReplayFetch, type Recording } from './recording.js';
import { contractTransport, contractRepo } from './contract-transport.js';
import { ContractFaults } from './contract-faults.js';
import { FakeClock } from '../services.js';

const directory = fileURLToPath(
  new URL(
    '../../../../../fixtures/github/2022-11-28/contracts/',
    import.meta.url,
  ),
);
const canonicalRun = '000000000001';
const redactor = createRedactor({
  preservedRepoUrls: ['https://github.com/ClarkeYeh/ai-office-spike'],
});
type Push = { branch: string; base: string; sha: string };
type Tape = {
  format: 1;
  source: 'live';
  startedAt: string;
  pushes: Push[];
  recordings: Recording[];
};
export const tapePath = (name: string) =>
  resolve(
    directory,
    createHash('sha256').update(name).digest('hex').slice(0, 16) + '.json',
  );

/** No fabricated HTTP tapes: each shared case is pending until its own live recording exists. */
export function githubContract(
  mode: 'replay' | 'live',
  create: GithubBindingFactory,
): void {
  describe(`scm-github ${mode}`, () => {
    let name = '';
    let persist: (() => Promise<void>) | undefined;
    beforeEach(({ task }) => {
      name = task.name;
      persist = undefined;
    });
    afterEach(async ({ task }) => {
      if (task.result?.state !== 'skip' && !task.result?.errors?.length)
        await persist?.();
    });
    scmPortContract(async () => {
      const path = tapePath(name);
      if (mode === 'replay' && !existsSync(path)) {
        return {
          repo: contractRepo,
          defaultBranch: 'main',
          scm: new Proxy(
            {},
            {
              get: () => () =>
                skipPending(`Awaiting integrator recording: ${name}`),
            },
          ) as ScmContractFixture['scm'],
          pushBranch: async () => skipPending('Awaiting recording'),
          editBody: async () => skipPending('Awaiting recording'),
        };
      }
      const tape: Tape | undefined =
        mode === 'replay'
          ? (JSON.parse(await readFile(path, 'utf8')) as Tape)
          : undefined;
      if (tape && (tape.format !== 1 || tape.source !== 'live'))
        throw new Error('Expected a live contract recording');
      const harness = mode === 'live' ? await openHarness() : undefined;
      const runId = harness?.ledger.data.runId ?? canonicalRun;
      const startedAt = tape?.startedAt ?? new Date().toISOString();
      const clock = new FakeClock(startedAt);
      const sleep = async (ms: number) => {
        if (mode === 'live') await new Promise<void>((r) => setTimeout(r, ms));
        clock.advance(ms);
      };
      const replay = tape ? new ReplayFetch(tape.recordings) : undefined;
      const recorder = harness
        ? new RecordingFetch(contractTransport(harness.fetch, runId), runId)
        : undefined;
      const pushes: Push[] = [];
      let pusher: GitPusher | undefined;
      let pushOffset = 0;
      let cleaned = false;
      const faults = new ContractFaults(() => clock.now().getTime());
      const fetch: typeof globalThis.fetch = faults.wrap(
        async (input, init) => {
          const request = new Request(input, init);
          const body = await request.clone().text();
          if (body) replay?.addKnownValues(JSON.parse(body));
          return (recorder?.fetch ?? replay!.fetch)(request);
        },
      );
      const scm = create({
        fetch,
        clock,
        sleep,
        registeredAt: () => startedAt,
      });
      const openPR = scm.openPR;
      scm.openPR = async (...args) => {
        try {
          return await openPR(...args);
        } catch (error) {
          if (
            mode === 'live' &&
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'not_implemented'
          )
            skipPending('Awaiting T5 createPrMethods assembly');
          throw error;
        }
      };
      const normalize = (v: string) => v.replaceAll(runId, canonicalRun);
      const fixture: ScmContractFixture = {
        settle: async (ms) => {
          clock.advance(ms);
        },
        loseNextResponse: faults.loseNextResponse,
        listLagMs: faults.listLagMs,
        scm,
        repo: contractRepo,
        defaultBranch: 'main',
        branchPrefix: `ai-office/t${runId}-`,
        pushBranch: async (branch) => {
          const base = (await scm.compareBranch(contractRepo, branch, branch))!
            .headSha;
          if (harness) {
            pusher ??= await GitPusher.create(harness.ledger, harness.gate);
            const sha = await pusher.push({ branch, base });
            pushes.push({ branch: normalize(branch), base, sha });
            return sha;
          }
          const next = tape!.pushes[pushOffset++];
          expect(next).toMatchObject({ branch, base });
          return next!.sha;
        },
        editBody: async (issue, body) => {
          const previous = await scm.getIssue(issue);
          const marker = previous.body.match(
            /<!-- ai-office:cmd=[^>]+ -->/,
          )?.[0];
          await scm.updateIssue(issue, {
            body:
              marker && !body.includes(marker) ? `${body}\n\n${marker}` : body,
          });
        },
        closeExternally: async (pr) => {
          await scm.updatePR(pr, { state: 'closed' });
        },
        dispose: async () => {
          if (harness) {
            try {
              const result = await harness.cleanup();
              console.info(
                JSON.stringify({
                  case: name,
                  ...result,
                  calls: harness.gate.calls,
                }),
              );
              assertClean(result);
              cleaned = true;
            } finally {
              try {
                await pusher?.close();
              } finally {
                await harness.close();
              }
            }
          } else {
            replay!.assertConsumed();
            expect(pushOffset).toBe(tape!.pushes.length);
          }
        },
      };
      if (recorder && process.env.AIO_GITHUB_RECORD === '1')
        persist = async () => {
          if (!cleaned)
            throw new Error('Refusing to publish before successful cleanup');
          await mkdir(directory, { recursive: true });
          const value: Tape = {
            format: 1,
            source: 'live',
            startedAt,
            pushes,
            recordings: recorder.recordings,
          };
          const serialized = JSON.stringify(value, null, 2) + '\n';
          if (
            JSON.stringify(redactor.sanitize(value)) !== JSON.stringify(value)
          )
            throw new Error('Contract tape leak scan failed');
          await writeFile(path, serialized, { flag: 'wx', mode: 0o600 });
        };
      return fixture;
    });
    let skipPending: (reason: string) => never;
    beforeEach((context) => {
      skipPending = (reason) => context.skip(reason);
    });
  });
}
