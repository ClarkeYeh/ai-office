import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { assembleContractScm } from '../../adapters/scm-github/test-support/assembly.js';
import {
  checkAcceptance,
  parseFacts,
} from '../../test-support/acceptance-check/index.js';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { assertClean, openHarness } from '../../test-support/github/harness.js';
import { GitPusher } from '../../test-support/github/pusher.js';
import { API } from '../../test-support/github/safety.js';
import { githubRehearsalFacts } from '../../test-support/joint/rehearsal/github-facts.js';
import { segmentRecording } from '../../test-support/joint/rehearsal/recording.js';
import {
  runRehearsal,
  type RehearsalReport,
} from '../../test-support/joint/rehearsal/run.js';
import {
  rehearsalHttpPath,
  rehearsalTracePath,
} from '../../test-support/joint/rehearsal/tapes.js';

/*
 * M5-T11 rehearsal, live on ClarkeYeh/ai-office-spike (GB level, M5_PLAN
 * §1.4, §2.4): T9's fake-world m5-mainline in the killable child, real
 * scm-github in this process on the test namespace `ai-office/t<runId>`, two
 * exact kill windows (P1, P2) with a same-home same-port restart each. The T7
 * gate holds the GitHub live lock and checks the account and quota; every write
 * is ledgered and the janitor plus the independent scan must end at 0. The
 * final PR (base main) is never merged. `AIO_GITHUB_RECORD=1` writes segment 1
 * (before the first kill): the event-semantics trace the CI twin asserts and
 * the sanitized HTTP tape (evidence only, M3-T15 ruling). The private report
 * holds counts, booleans and durations only.
 *
 *   pnpm -r build && AIO_REAL_GITHUB=1 AIO_T11_REHEARSAL=1 [AIO_GITHUB_RECORD=1] \
 *     pnpm exec vitest run --project @ai-office/server-github \
 *     apps/server/src/acceptance/joint/rehearsal.github.test.ts
 */
realGithubSuite('M5-T11 rehearsal (live spike, fake runtime)', () => {
  // Its own opt-in on top of the T7 gate: `pnpm test:github` must not start it.
  it.skipIf(process.env.AIO_T11_REHEARSAL !== '1')(
    'reconciles P1 and P2 to one Issue and one merge, ready ≤ 60 s, leftovers 0',
    async () => {
      const harness = await openHarness();
      const runId = harness.ledger.data.runId;
      const base = await mkdtemp(join(tmpdir(), 'aio-rehearsal-live-'));
      const remaining = async () => {
        const response = await harness.fetch(`${API}/rate_limit`);
        const data = (await response.json()) as {
          resources?: { core?: { remaining?: number } };
        };
        return data.resources?.core?.remaining ?? -1;
      };
      const record: Record<string, unknown> = { runId };
      let pusher: GitPusher | undefined;
      let report: RehearsalReport | undefined;
      const recorded = segmentRecording(harness.fetch, runId);
      try {
        record.rateLimitBefore = await remaining();
        await harness.ensureLabel();
        pusher = await GitPusher.create(harness.ledger, harness.gate, {
          ...(process.env.AIO_TEST_REPO_PATH
            ? { sourcePath: process.env.AIO_TEST_REPO_PATH }
            : {}),
        });
        const startedAt = new Date().toISOString();
        const scm = assembleContractScm({
          fetch: recorded.fetch,
          clock: { now: () => new Date() },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          registeredAt: () => startedAt,
        });
        report = await runRehearsal(
          {
            mode: 'live',
            scm,
            runId,
            pusher,
            ...githubRehearsalFacts(harness.api, runId, startedAt),
            endSegment1: () => recorded.stop(),
            pollMs: 2_000,
            stallMs: 15 * 60_000,
          },
          {
            home: join(base, 'home'),
            judge: (events, facts) =>
              checkAcceptance(events, parseFacts(facts)),
          },
        );
      } finally {
        try {
          const result = await harness.cleanup();
          Object.assign(record, {
            report,
            requests: recorded.counts,
            notModifiedRatio: recorded.counts.requests
              ? +(
                  recorded.counts.notModified / recorded.counts.requests
                ).toFixed(3)
              : 0,
            cleanup: {
              leftovers: result.leftovers,
              scanOpenObjects: result.scan.openObjects.length,
              scanBranches: result.scan.branches.length,
            },
            rateLimitAfter: await remaining(),
          });
          const path = `${process.env.HOME}/.ai-office/test-state/t11-rehearsal-${runId}.json`;
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, JSON.stringify(record, null, 2) + '\n', {
            mode: 0o600,
          });
          console.info(`[T11] private report: ${path}`);
          console.info(
            JSON.stringify({
              ...record,
              report: report && {
                failed: report.failed,
                windows: report.windows,
                scmCalls: report.scmCalls,
                checker: report.checker?.summary,
                minutesTotal: report.minutesTotal,
              },
            }),
          );
          assertClean(result);
        } finally {
          await pusher?.close();
          await harness.close();
          if (!process.env.AIO_DEBUG_HOME)
            await rm(base, { recursive: true, force: true });
        }
      }
      expect(report?.failed).toEqual([]);
      if (report && process.env.AIO_GITHUB_RECORD === '1') {
        recorded.sanitize();
        await writeFile(
          rehearsalTracePath,
          JSON.stringify(
            { format: 1, source: 'live', segment1: report.segment1 },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        );
        await recorded.recorder.save(rehearsalHttpPath);
      }
    },
    3_600_000,
  );
});
