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
import { API, ROOT } from '../../../test-support/github/safety.js';
import {
  TapeLeakError,
  assertTapeSafe,
} from '../../../test-support/github/tape-normalization.js';
import type { MixedBinding } from './mixed-office.js';
import type { StepResult } from './scenario.js';
import { liveHttpPath } from './tapes.js';

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
  action: (
    binding: MixedBinding,
    steps: StepResult[],
  ) => Promise<{ value: T; steps: StepResult[] }>,
  save: (recorder: RecordingFetch, value: T) => Promise<void>,
): Promise<T> {
  const harness = await openHarness();
  const runId = harness.ledger.data.runId;
  let pusher: GitPusher | undefined;
  const report: Record<string, unknown> = { name, runId };
  try {
    let outcome: { value: T; steps: StepResult[] } | undefined;
    const steps: StepResult[] = [];
    report.steps = steps;
    report.rateLimitBefore = await coreRemaining(harness);
    const recorded = scopedRecording(harness.fetch, runId);
    const recorder = recorded.recorder;
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
        return recorded.fetch(input, init);
      });
      const startedAt = new Date().toISOString();
      const scm = assembleContractScm({
        fetch,
        clock: { now: () => new Date() },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        registeredAt: () => startedAt,
      });
      outcome = await action(
        {
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
        },
        steps,
      );
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
      report.withheldResponses = recorded.withheld();
      report.withheldFieldPaths = recorded.withheldPaths();
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
    ) {
      // Evidence only (never replayed): the leak scan rejects concrete spike
      // API paths (numbers, SHAs, refs), so keep the path template.
      for (const r of recorder.recordings) r.path = r.pathTemplate;
      // A response the tape scan still rejects is withheld, never written.
      for (const r of recorder.recordings)
        if (leakPaths(r).length) {
          r.response = { withheld: 'tape leak scan' };
          r.headers = {};
        }
      const paths = leakPaths(recorder.recordings);
      if (paths.length)
        console.info(`[T15 ${name}] tape leak paths: ${paths.join(', ')}`);
      await mkdir(dirname(liveHttpPath), { recursive: true });
      await save(recorder, outcome.value);
    }
    return outcome.value;
  } finally {
    try {
      await pusher?.close();
    } finally {
      await harness.close();
    }
  }
}

/**
 * The adapter sees GitHub's full responses; the tape keeps only this run's
 * rows of collection responses (as the T8 contract transport does), so other
 * spike history never enters a fixture.
 */
function scopedRecording(transport: typeof fetch, runId: string) {
  const mine = (body: unknown) =>
    typeof body === 'string' &&
    (body.includes(`<!-- ai-office:cmd=t${runId}:`) ||
      body.includes(`<!-- aio-test:owner=t${runId}:`));
  let next: Response | undefined;
  const recorder = new RecordingFetch(async () => next!, runId);
  let tail: Promise<unknown> = Promise.resolve();
  let withheld = 0;
  // Field paths only (never values), for the private report.
  const withheldPaths: string[] = [];
  const record = async (request: Request): Promise<Response> => {
    const full = await transport(request.clone());
    const path = new URL(request.url).pathname;
    next = full.clone();
    if (![204, 205, 304].includes(full.status)) {
      const data: unknown = await full
        .clone()
        .json()
        .catch(() => undefined);
      let scoped = data;
      if (Array.isArray(data) && /\/(issues|pulls)(\/comments)?$/.test(path))
        scoped = data.filter((row: { body?: unknown }) => mine(row.body));
      else if (
        Array.isArray(data) &&
        path.startsWith(`${ROOT}/git/matching-refs/`)
      )
        scoped = data.filter((row: { ref?: string }) =>
          row.ref?.startsWith(`refs/heads/ai-office/t${runId}`),
        );
      if (scoped !== data)
        next = new Response(JSON.stringify(scoped), {
          status: full.status,
          headers: full.headers,
        });
    }
    try {
      await recorder.fetch(request);
    } catch (error) {
      if (!(error instanceof TapeLeakError)) throw error;
      recorder.acknowledge(error);
      // The leak scan runs while recording (T8): a response carrying data that
      // must never enter a fixture is recorded withheld. The adapter always
      // gets the real response.
      withheld++;
      const data: unknown = await full
        .clone()
        .json()
        .catch(() => undefined);
      const where = `${request.method} ${new URL(request.url).pathname.replace(ROOT, '').replace(/[a-f0-9]{40}/g, '{sha}')}`;
      for (const leak of leakPaths(data))
        withheldPaths.push(`${where} ${leak}`);
      next = new Response(
        [204, 205, 304].includes(full.status)
          ? null
          : JSON.stringify({ withheld: 'tape leak scan' }),
        { status: full.status },
      );
      await recorder.fetch(request);
    }
    return full;
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const result = tail.then(() => record(request));
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    recorder,
    fetch,
    withheld: () => withheld,
    withheldPaths: () => [...new Set(withheldPaths)],
  };
}

/** JSON paths (never values) whose leaf fails the tape leak scan. */
function leakPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    try {
      assertTapeSafe(value);
      return [];
    } catch {
      return [path];
    }
  }
  if (Array.isArray(value))
    return value.flatMap((v, i) => leakPaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) =>
      leakPaths(v, `${path}.${k}`),
    );
  return [];
}
