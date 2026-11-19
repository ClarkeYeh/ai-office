import { join } from 'node:path';
import { homedir } from 'node:os';
import { openGate, type GateOptions } from './gate.js';
import { Ledger, emptyLedger, loadLedger } from './ledger.js';
import { newRunId, LABEL } from './safety.js';
import { guardedFetch } from './transport.js';
import { GithubApi } from './api.js';
import { cleanup } from './janitor.js';
import { RecordingFetch } from './recording.js';

export async function openHarness(
  options: GateOptions & {
    ledgerPath?: string;
    recover?: boolean;
    record?: boolean;
  } = {},
) {
  const gate = await openGate(options);
  try {
    const runId = newRunId();
    const ledger = new Ledger(
      options.ledgerPath ??
        join(homedir(), `.ai-office/test-state/github-${runId}.json`),
      options.recover && options.ledgerPath
        ? await loadLedger(options.ledgerPath)
        : emptyLedger(runId),
    );
    await ledger.save();
    const recorder = options.record
      ? new RecordingFetch(gate.fetch, ledger.data.runId)
      : undefined;
    const fetch = guardedFetch(recorder?.fetch ?? gate.fetch, ledger);
    const api = new GithubApi(fetch);
    const cleanupApi = new GithubApi(gate.fetch);
    return {
      gate,
      ledger,
      fetch,
      api,
      recorder,
      async ensureLabel() {
        if ((await api.request('GET', `/labels/${LABEL}`)).status === 404)
          await api.request('POST', '/labels', {
            name: LABEL,
            color: 'ededed',
            description:
              'AI Office synthetic test resources; closed issues are retained',
          });
      },
      async cleanup(apply = true) {
        return cleanup(ledger, cleanupApi, { apply });
      },
      close: () => gate.close(),
    };
  } catch (error) {
    await gate.close();
    throw error;
  }
}

export async function withHarness<T>(
  action: (harness: Awaited<ReturnType<typeof openHarness>>) => Promise<T>,
  options: Parameters<typeof openHarness>[0] = {},
): Promise<T> {
  const harness = await openHarness(options);
  try {
    try {
      return await action(harness);
    } finally {
      const result = await harness.cleanup();
      if (
        result.leftovers ||
        result.scan.openObjects.length ||
        result.scan.branches.length
      )
        assertClean(result);
    }
  } finally {
    await harness.close();
  }
}

export function assertClean(result: Awaited<ReturnType<typeof cleanup>>): void {
  if (
    result.leftovers ||
    result.scan.openObjects.length ||
    result.scan.branches.length
  )
    throw new Error('GitHub leftovers remain; inspect private ledger');
}
