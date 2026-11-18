/**
 * M2-T17 hybrid E2E (real Orca + scm-fake + usage-sessionlog): built-in
 * `feature-to-pr` meeting (Claude lead/PM/architect + Codex engineer, 2 rounds)
 * → conclusion gate → planning → task-split gate, then cancel + cleanup there
 * (review N12). The backend is a child process with a minimal environment and
 * is `kill -9`'d once mid-meeting, then restarted on the same home.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { OrcaHarness } from '../harness.js';
import { requireValue } from '../contract-live-cli.js';
import {
  attempts,
  count,
  duplicatedFacts,
  errorAttempts,
  rateLimitReport,
  repeatedSends,
  sendsPerAttempt,
  spawnStallFalsePositives,
  statesByAgent,
  submittingAgents,
  usageByRole,
} from './checks.js';
import {
  adoptRun,
  backendHome,
  drive,
  events,
  Expectations,
  readModel,
  registerRepo,
  session,
  startWorkflow,
  writeReport,
  type Api,
  type DriveRecord,
} from './office.js';
import {
  alive,
  checkProcesses,
  startBackendProcess,
  type BackendProcess,
} from './backend-process.js';

const git = promisify(execFile);

export const assertClean = true;

const REQUIREMENT =
  'Add a file GREETING.md at the repository root containing one line: "Hello from AI Office". Keep the change minimal; no other files.';

export async function run(h: OrcaHarness): Promise<void> {
  const home = process.env.HOME;
  requireValue(home, 'HOME required');
  const orcaHome = join(home, '.ai-office', 'orca-home');
  const kill = process.env.AIO_T17_KILL !== '0';
  const dir = await backendHome(h, { enforcement: 'on' });
  const effects = await h.composedBackend(dir);
  let backend: BackendProcess = await startBackendProcess({
    home: dir,
    orcaHome,
    effects,
    logName: 'backend-1.log',
  });
  await effects.settle();
  const expect = new Expectations();
  const record: DriveRecord = {
    stageGates: [],
    cliCallsPerMinute: [],
    exceptions: [],
  };
  const report: Record<string, unknown> = {};
  let taskSplitOpen = false;
  let api: Api = await session(backend.url, backend.bootstrapUrl);
  let workflowId: string | undefined;
  let orcaRun: string | undefined;
  try {
    // §17.3 registration through the composed runtime (`repo list` lookup only).
    const repoId = await registerRepo(api, h.ledger.repoPath);
    const started = await startWorkflow(h, api, {
      templateId: 'feature-to-pr',
      repoId,
      requirement: REQUIREMENT,
      // Budget enforcement ON with a wide test budget (M2_PLAN T17): bars and
      // events must have numbers without a budget gate interrupting the run.
      budgetOverrides: {
        stages: {
          meeting: { tokens: 50_000_000 },
          breakdown: { tokens: 50_000_000 },
        },
        workflowBudget: { tokens: 200_000_000 },
      },
    });
    workflowId = started.workflowId;
    const id = workflowId;
    const startedAt = Date.now();
    const runOf = async () => (orcaRun ??= await adoptRun(h, api, id));

    // Mid-meeting crash: once both agent kinds are working, kill -9 the backend
    // while its consuming check long poll is in flight, then restart it.
    if (kill) {
      for (let i = 0; ; i++) {
        const log = await events(api, id);
        await runOf();
        const working = new Set(
          log
            .filter(
              (e) => e.type === 'seat.status' && e.payload.state === 'working',
            )
            .map((e) => attempts(log).get(e.payload.attemptId)?.agent),
        );
        if (working.has('claude-code') && working.has('codex')) break;
        const failed = log.find(
          (e) =>
            e.type === 'command.failed' &&
            e.payload.kind === 'runtime.spawnAgent',
        );
        if (failed)
          throw new Error(
            `Spawn failed before the kill point: ${JSON.stringify(failed.payload.error)}`,
          );
        if (i > 450) throw new Error('Meeting agents never started working');
        await delay(2_000);
      }
      const shim = h.ledger.shims.find((s) => !s.done)?.id;
      requireValue(shim, 'Composed shim missing');
      const before = await checkProcesses(shim);
      const seqBefore = (await readModel(api, id)).lastSeq as number;
      await backend.kill9();
      const orphansAtKill = await alive(before);
      backend = await startBackendProcess({
        home: dir,
        orcaHome,
        logName: 'backend-2.log',
      });
      api = await session(backend.url, backend.bootstrapUrl);
      // Startup cleanup reaps the killed backend's process groups.
      let survivors = await alive(orphansAtKill);
      for (let i = 0; survivors.length && i < 30; i++) {
        await delay(1_000);
        survivors = await alive(orphansAtKill);
      }
      report.kill9 = {
        checkPollsBeforeKill: before.length,
        orphansAtKill: orphansAtKill.length,
        orphansAfterRestart: survivors.length,
        seqBefore,
      };
      expect.that(before.length > 0, 'a consuming check was in flight at kill');
      expect.that(
        survivors.length === 0,
        'orphan check processes reaped on restart',
      );
    }

    const final = await drive(
      h,
      api,
      id,
      (w) => w.status !== 'running' || taskSplitOpen,
      {
        run: () => orcaRun,
        record,
        onStageGate: async (gate) => {
          await runOf();
          if (
            gate.stageKind === 'planning' ||
            gate.gateId.includes('task-split')
          ) {
            taskSplitOpen = true;
            return true;
          }
          return false;
        },
      },
    );
    report.reachedTaskSplit = taskSplitOpen;
    report.statusAtTaskSplit = final.status;
    report.budgetBars = final.budget ?? final.budgetBars ?? null;
    expect.that(taskSplitOpen, 'task-split gate reached');

    // Cancel at the task-split gate and run the product cleanup path.
    const cancel = await api.call('POST', `/api/v1/workflows/${id}/cancel`, {});
    expect.that(cancel.status < 300, `cancel accepted (${cancel.status})`);
    for (let i = 0; i < 120; i++) {
      if ((await readModel(api, id)).status === 'cancelled') break;
      await delay(2_000);
    }
    const cleaned = await api.call(
      'POST',
      `/api/v1/workflows/${id}/cleanup`,
      {},
    );
    expect.that(cleaned.status < 300, `cleanup accepted (${cleaned.status})`);
    // The backend must remove its own meeting/planning worktrees (claimed scan).
    // The live backend's own shim is expected here; the runner closes it.
    const resources = async () =>
      (await h.scan()).filter((r) => r.kind !== 'shim');
    let leftovers = await resources();
    for (let i = 0; leftovers.length && i < 60; i++) {
      await delay(2_000);
      leftovers = await resources();
    }
    const log = await events(api, id);
    const meetingBase = log.find(
      (e) =>
        e.type === 'command.issued' &&
        e.payload.kind === 'runtime.prepareWorkspace' &&
        String(e.payload.args?.name ?? '').endsWith('-meeting'),
    )?.payload.args;
    const remoteMain = (
      await git('/usr/bin/git', [
        '-C',
        h.ledger.repoPath,
        'ls-remote',
        'origin',
        'refs/heads/main',
      ])
    ).stdout.split(/\s+/)[0];
    const meetingResult = log.find(
      (e) =>
        e.type === 'command.succeeded' &&
        e.payload.kind === 'runtime.prepareWorkspace',
    )?.payload.result;
    const states = statesByAgent(log);
    const stall = spawnStallFalsePositives(log);
    Object.assign(report, {
      minutes: Math.round((Date.now() - startedAt) / 60_000),
      statesByAgent: states,
      submittingAgents: submittingAgents(log),
      activityEvents: count(log, 'seat.activity'),
      exitedEvents: count(log, 'seat.exited'),
      meetingRounds: log
        .filter((e) => e.type === 'meeting.round_completed')
        .map((e) => e.payload.round),
      sendsPerAttempt: Object.values(sendsPerAttempt(log)),
      repeatedSends: repeatedSends(log).length,
      errorAttempts: errorAttempts(log).length,
      duplicatedFacts: duplicatedFacts(log),
      spawnStall: stall,
      rateLimit: rateLimitReport(log),
      exceptions: record.exceptions,
      stageGates: record.stageGates.map((g) => ({
        gate: g.stageKind,
        live: g.live.length,
      })),
      maxCliCallsPerMinute: Math.max(0, ...record.cliCallsPerMinute),
      meetingBase: {
        baseBranch: meetingBase?.baseBranch,
        matchesRemoteMain: JSON.stringify(meetingResult ?? {}).includes(
          String(remoteMain),
        ),
      },
      backendLeftoversAfterCleanup: leftovers.map((r) => r.kind),
      usage: usageByRole(log),
    });
    for (const agent of ['claude-code', 'codex']) {
      for (const state of ['working', 'done'])
        expect.that(
          states[agent]?.includes(state) ?? false,
          `${agent} reported ${state}`,
        );
    }
    expect.that(
      submittingAgents(log).join() === 'claude-code,codex',
      'both agent kinds submitted through the identity check',
    );
    expect.that(count(log, 'seat.activity') > 0, 'seat.activity observed');
    expect.that(count(log, 'seat.exited') > 0, 'seat.exited observed');
    expect.that(
      log.some(
        (e) => e.type === 'meeting.round_completed' && e.payload.round === 2,
      ),
      'keep-open second meeting round completed (P6)',
    );
    expect.that(
      repeatedSends(log).length === 0,
      'no repeated follow-up send (turn start unobserved)',
    );
    expect.that(errorAttempts(log).length === 0, 'no attempt in error');
    expect.that(duplicatedFacts(log).length === 0, 'no duplicated ingestion');
    expect.that(
      stall.nudges === 0 && stall.gates === 0,
      'no spawn-stall false positive at the default 10 minutes',
    );
    expect.that(
      meetingBase?.baseBranch === 'origin/main',
      'meeting worktree based on origin/<default>',
    );
    expect.that(
      record.stageGates.every((g) => g.live.length === 0),
      'no live Orca worker while a stage gate is open',
    );
    expect.that(
      record.cliCallsPerMinute.every((n) => n <= 120),
      'steady-state CLI calls per minute ≤ 120',
    );
    expect.that(
      usageByRole(log).some(
        (r) => r.agent === 'claude-code' && r.budgetTokens > 0,
      ) &&
        usageByRole(log).some((r) => r.agent === 'codex' && r.budgetTokens > 0),
      'usage events carry numbers for both providers',
    );
    expect.that(
      leftovers.length === 0,
      'backend cleanup removed its resources',
    );
  } finally {
    if (workflowId)
      await writeReport(h, 'hybrid', report).catch(() => undefined);
    await backend.stop();
  }
  expect.assert();
}
