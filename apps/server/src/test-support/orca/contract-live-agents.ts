/** Two tiny agent cases; opt-in and ledger ownership are enforced by T8. */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { OrcaHarness } from './harness.js';
import { collectDispatchUsage } from './usage.js';
import { requireValue, setup } from './contract-live-cli.js';
import { detectRateLimit } from '../../adapters/runtime-orca/observe/index.js';
import { detectRateLimitPause } from './rate-limit.js';

async function waitDone(
  h: OrcaHarness,
  shim: string,
  run: string,
  dispatch: string,
) {
  // At most ten minutes of active waiting. A provider pause is reported distinctly
  // and never causes another worker-start or consumes the scenario retry budget.
  for (let i = 0; i < 20; i++) {
    const batch = await h.command([
      'orchestration',
      'check',
      '--terminal',
      shim,
      '--run',
      run,
      '--wait',
      '--timeout-ms',
      '30000',
      '--retry-request',
      randomUUID(),
      '--json',
      '--full',
    ]);
    const messages = batch.messages as { type: string; payload?: string }[];
    requireValue(Array.isArray(messages), 'Missing check messages');
    for (const m of messages) {
      if (m.type !== 'worker_done') continue;
      const payload = JSON.parse(m.payload ?? '{}') as {
        dispatchId?: string;
        outcome?: string;
      };
      if (payload.dispatchId === dispatch) {
        requireValue(
          payload.outcome === 'succeeded',
          'Contract agent did not succeed',
        );
        return;
      }
    }
    const detail = await h.command([
      'orchestration',
      'worker-show',
      '--dispatch',
      dispatch,
      '--json',
      '--full',
    ]);
    if (detectRateLimitPause(detail, undefined, detectRateLimit))
      throw new Error(
        'Provider window pause: defer validation; do not count as a scenario defect or auto-retry',
      );
  }
  throw new Error('Contract agent did not finish within active wait window');
}
export async function run(h: OrcaHarness): Promise<void> {
  const { shim, run } = await setup(h);
  const sha = process.env.AIO_TEST_BASE_SHA;
  requireValue(sha, 'AIO_TEST_BASE_SHA required');
  const name = basename(h.ledger.dataDir);
  await h.createWorktree(name, `ai-office-test/${name}`, sha);
  const workspace = h.ledger.worktrees.at(-1)!;
  const startedAt = new Date().toISOString();
  const spec =
    'This is a runtime contract probe. Do not edit files or start helpers. Immediately report worker_done succeeded to your coordinator using the provided task and dispatch IDs, with a three-sentence summary saying the probe completed, no files changed, and nothing remains.';
  const start = () => [
    'orchestration',
    'worker-start',
    '--from',
    shim,
    '--agent',
    'codex',
    '--worktree',
    `id:${workspace.id}`,
    '--keep-open',
    '--spec',
    spec,
    '--retry-request',
    randomUUID(),
    '--json',
    '--full',
  ];
  try {
    // Case 1: replay of spawn, then a second turn on the kept terminal.
    const args = start();
    const first = await h.command(args);
    requireValue(
      ['ready', 'started', 'starting', 'input_accepted'].includes(
        String(first.state),
      ) && typeof first.dispatchId === 'string',
      'Spawn receipt is not started',
    );
    const repeated = await h.command(args);
    requireValue(
      repeated.dispatchId === first.dispatchId,
      'Spawn replay created a second dispatch',
    );
    await waitDone(h, shim, run, first.dispatchId);
    await delay(120_001);
    const next = await h.command([
      'orchestration',
      'send',
      '--from',
      shim,
      '--to',
      `dispatch:${first.dispatchId}`,
      '--subject',
      'aio:contract-followup second turn',
      '--body',
      spec,
      '--retry-request',
      randomUUID(),
      '--json',
      '--full',
    ]);
    requireValue(
      next.delivery === 'follow_up' &&
        next.followUpOf === first.dispatchId &&
        typeof next.dispatchId === 'string',
      'Keep-open did not create a linked follow-up',
    );
    await waitDone(h, shim, run, next.dispatchId);
    // Stop/release idempotency on an actually owned dispatch, never a fabricated ID.
    for (const verb of ['worker-stop', 'worker-release'])
      for (let i = 0; i < 2; i++) {
        const receipt = await h.command([
          'orchestration',
          verb,
          '--dispatch',
          next.dispatchId,
          '--retry-request',
          randomUUID(),
          '--json',
          '--full',
        ]);
        requireValue(
          verb === 'worker-stop'
            ? receipt.alreadySettled === true ||
                ['stopped', 'succeeded', 'released'].includes(
                  String(receipt.state),
                )
            : ['released', 'already_released'].includes(String(receipt.state)),
          'Lifecycle operation did not settle',
        );
      }
    // Case 2: record worker-list while worker-start is in flight. Timing evidence
    // cannot be guaranteed by a live CLI; replay deterministically holds receipt.
    const pending = h.command(start());
    const observation = h.command([
      'orchestration',
      'worker-list',
      '--run',
      run,
      '--json',
      '--full',
    ]);
    const results = await Promise.allSettled([pending, observation]);
    const launch = results[0]!,
      inventory = results[1]!;
    if (launch.status === 'rejected') throw launch.reason;
    if (inventory.status === 'rejected') throw inventory.reason;
    const spawned = launch.value,
      observed = inventory.value;
    requireValue(
      typeof spawned.dispatchId === 'string' && spawned.state !== 'failed',
      'In-flight spawn did not start',
    );
    requireValue(
      Array.isArray(observed.workers),
      'Missing in-flight worker inventory',
    );
    await waitDone(h, shim, run, spawned.dispatchId);
  } finally {
    await collectDispatchUsage(
      h,
      h.ledger.dispatches.map((d) => ({
        agent: 'codex',
        attemptId: d.id,
        dispatchId: d.id,
        startedAt,
      })),
    );
  }
}
