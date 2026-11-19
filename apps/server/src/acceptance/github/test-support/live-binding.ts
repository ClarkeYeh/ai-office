import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assembleContractScm } from '../../../adapters/scm-github/test-support/assembly.js';
import {
  openHarness,
  assertClean,
} from '../../../test-support/github/harness.js';
import { GitPusher } from '../../../test-support/github/pusher.js';
import { RecordingFetch } from '../../../test-support/github/recording.js';
import { ContractFaults } from '../../../test-support/github/contract-faults.js';
import { githubOwnerActions } from '../../../test-support/github/owner-actions.js';
import { API } from '../../../test-support/github/safety.js';
import type { MixedBinding } from './mixed-office.js';
import type { StepResult } from './scenario.js';

type Harness = Awaited<ReturnType<typeof openHarness>>;
const coreRemaining = async (harness: Harness): Promise<number> => {
  const response = await harness.fetch(`${API}/rate_limit`);
  const data = (await response.json()) as {
    resources?: { core?: { remaining?: number } };
  };
  return data.resources?.core?.remaining ?? -1;
};

/**
 * One live T15 run on the spike: the T7 harness (gate, live lock, ledger,
 * guarded transport), its git pusher, scm-github recorded below injected
 * faults, and step 13 (janitor leftovers 0, scan 0, rate-limit usage).
 */
export async function withLiveRun<T>(
  name: string,
  action: (binding: MixedBinding) => Promise<{ value: T; steps: StepResult[] }>,
  save: (recorder: RecordingFetch, value: T) => Promise<void>,
): Promise<T> {
  const harness = await openHarness();
  const runId = harness.ledger.data.runId;
  let pusher: GitPusher | undefined;
  const report: Record<string, unknown> = { name, runId };
  try {
    let outcome: { value: T; steps: StepResult[] } | undefined;
    report.rateLimitBefore = await coreRemaining(harness);
    const recorder = new RecordingFetch(harness.fetch, runId);
    try {
      await harness.ensureLabel();
      pusher = await GitPusher.create(harness.ledger, harness.gate, {
        ...(process.env.AIO_TEST_REPO_PATH
          ? { sourcePath: process.env.AIO_TEST_REPO_PATH }
          : {}),
      });
      const faults = new ContractFaults(() => Date.now());
      let down = false;
      const fetch = faults.wrap(async (input, init) => {
        if (down) throw new TypeError('Injected network outage');
        return recorder.fetch(input, init);
      });
      const startedAt = new Date().toISOString();
      const scm = assembleContractScm({
        fetch,
        clock: { now: () => new Date() },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        registeredAt: () => startedAt,
      });
      outcome = await action({
        mode: 'live',
        scm,
        runId,
        pusher,
        owner: githubOwnerActions(harness.api, runId),
        stepTimeoutMs: 600_000,
        faults: {
          loseNextCreateIssue(listLagMs) {
            faults.loseNextResponse('createIssue');
            faults.listLagMs(listLagMs);
          },
          setScmDown(value) {
            down = value;
          },
        },
      });
      report.steps = outcome.steps;
    } finally {
      // Step 13: close every ledger object, then the independent scan.
      const result = await harness.cleanup();
      report.cleanup = {
        leftovers: result.leftovers,
        scanOpenObjects: result.scan.openObjects,
        scanBranches: result.scan.branches,
      };
      report.resources = harness.ledger.data.resources.map((r) => ({
        kind: r.kind,
        number: r.number,
        state: r.state,
        ...(r.kind === 'branch' ? { key: r.key } : {}),
      }));
      report.rateLimitAfter = await coreRemaining(harness);
      report.httpCalls = recorder.recordings.length;
      report.gateCalls = harness.gate.calls.length;
      const path = `${process.env.HOME}/.ai-office/test-state/t15-${name}-${runId}.json`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
      });
      console.info(`[T15 ${name}] private report: ${path}`);
      console.info(JSON.stringify({ ...report, steps: undefined }));
      assertClean(result);
    }
    if (
      process.env.AIO_GITHUB_RECORD === '1' &&
      outcome.steps.every((s) => s.ok)
    )
      await save(recorder, outcome.value);
    return outcome.value;
  } finally {
    try {
      await pusher?.close();
    } finally {
      await harness.close();
    }
  }
}
