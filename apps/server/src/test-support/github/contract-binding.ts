import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect } from 'vitest';
import { TapeNormalizer, assertTapeSafe } from './tape-normalization.js';
import { PersistenceFailures } from './persistence-failures.js';
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
import { scenarioTime } from './scenario-time.js';
import { GithubCaseScope } from './case-scope.js';
import { visibleWrites } from './visibility.js';

const directory = fileURLToPath(
  new URL(
    '../../../../../fixtures/github/2022-11-28/contracts/',
    import.meta.url,
  ),
);
const canonicalRun = '000000000001';
type Push = { branch: string; base: string; sha: string };
type Tape = {
  format: 2;
  clockReads: number[];
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
    const failures = new PersistenceFailures();
    afterAll(() => failures.assertSuccess());
    let name = '';
    let scope: GithubCaseScope;
    let activeCleanup: () => Promise<void>;
    const hookTimeoutMs = 300_000;
    let persist: (() => Promise<void>) | undefined;
    beforeEach(({ task, signal }) => {
      scope = new GithubCaseScope(signal);
      activeCleanup = async () => {};
      name = task.name;
      persist = undefined;
    });
    afterEach(async ({ task }) => {
      await scope.dispose(activeCleanup);
      if (task.result?.state !== 'skip' && !task.result?.errors?.length)
        await failures.capture(name, async () => {
          await persist?.();
        });
    }, hookTimeoutMs);
    scmPortContract(
      () =>
        scope.run(async () => {
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
          if (tape && (tape.format !== 2 || tape.source !== 'live'))
            throw new Error('Expected a live contract recording');
          let harness: Awaited<ReturnType<typeof openHarness>> | undefined;
          let pusher: GitPusher | undefined;
          let cleaned = false;
          activeCleanup = async () => {
            if (!harness) return;
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
          };
          if (mode === 'live') harness = await openHarness();
          const runId = harness?.ledger.data.runId ?? canonicalRun;
          const startedAt = tape?.startedAt ?? new Date().toISOString();
          const time = scenarioTime(mode, tape?.clockReads, scope.signal);
          const { clock } = time;
          const sleep = (ms: number) => scope.run(() => time.sleep(ms));
          const replay = tape ? new ReplayFetch(tape.recordings) : undefined;
          const recorder = harness
            ? new RecordingFetch(
                contractTransport(visibleWrites(harness.fetch), runId),
                runId,
              )
            : undefined;
          const pushes: Push[] = [];
          let pushOffset = 0;
          const faults = new ContractFaults(() => clock.now().getTime());
          const fetch: typeof globalThis.fetch = faults.wrap(
            async (input, init) => {
              const request = new Request(input, init);
              const body = await request.clone().text();
              if (body) replay?.addKnownValues(JSON.parse(body));
              return scope.run(() =>
                (recorder?.fetch ?? replay!.fetch)(request),
              );
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
            settle: sleep,
            loseNextResponse: faults.loseNextResponse,
            listLagMs: faults.listLagMs,
            scm,
            repo: contractRepo,
            defaultBranch: 'main',
            branchPrefix: `ai-office/t${runId}-`,
            pushBranch: (branch) =>
              scope.run(async () => {
                const base = (await scm.compareBranch(
                  contractRepo,
                  branch,
                  branch,
                ))!.headSha;
                if (harness) {
                  pusher ??= await GitPusher.create(
                    harness.ledger,
                    harness.gate,
                  );
                  const sha = await pusher.push({ branch, base });
                  pushes.push({ branch: normalize(branch), base, sha });
                  return sha;
                }
                const next = tape!.pushes[pushOffset++];
                expect(next).toMatchObject({ branch, base });
                return next!.sha;
              }),
            editBody: async (issue, body) => {
              const previous = await scm.getIssue(issue);
              const marker = previous.body.match(
                /<!-- ai-office:cmd=[^>]+ -->/,
              )?.[0];
              await scm.updateIssue(issue, {
                body:
                  marker && !body.includes(marker)
                    ? `${body}\n\n${marker}`
                    : body,
              });
            },
            closeExternally: async (pr) => {
              await scm.updatePR(pr, { state: 'closed' });
            },
            dispose: async () => {
              await scope.dispose(activeCleanup);
              // The adapter reports a leak as github_unavailable; fail as the harness.
              recorder?.assertNoLeak();
              if (!harness) {
                replay!.assertConsumed();
                time.assertConsumed();
                expect(pushOffset).toBe(tape!.pushes.length);
              }
            },
          };
          if (recorder && process.env.AIO_GITHUB_RECORD === '1')
            persist = async () => {
              if (!cleaned)
                throw new Error(
                  'Refusing to publish before successful cleanup',
                );
              recorder.assertNoLeak();
              await mkdir(directory, { recursive: true });
              const value = new TapeNormalizer().value<Tape>({
                format: 2,
                clockReads: time.reads,
                source: 'live',
                startedAt,
                pushes,
                recordings: recorder.recordings,
              });
              const serialized = JSON.stringify(value, null, 2) + '\n';
              assertTapeSafe(value);
              await writeFile(path, serialized, { flag: 'wx', mode: 0o600 });
            };
          return fixture;
        }),
      { timeoutMs: mode === 'live' ? 360_000 : 30_000, hookTimeoutMs },
    );
    let skipPending: (reason: string) => never;
    beforeEach((context) => {
      skipPending = (reason) => context.skip(reason);
    });
  });
}
