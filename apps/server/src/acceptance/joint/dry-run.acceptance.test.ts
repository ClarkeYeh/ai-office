import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRY_RUN_NA, runDryRun } from '../../test-support/joint/dry-run.js';
import type { Json } from '../../test-support/orca/t17/office.js';

/*
 * M5-T7 PART 2 offline dry run: the joint harness against the built CLI in
 * fake mode (`ai-office start --dev --fake m5-mainline`), including the one
 * `kill -9` and same-home same-port restart, the owner policy with the held
 * code-name answer, the restart assertions, the B4 export, the T10 checker
 * and the fake-world leftover scan. No GitHub, no Orca. Needs `pnpm -r build`
 * (CI builds before `pnpm test`).
 */
describe('M5-T7 offline dry run (--dev --fake m5-mainline)', () => {
  it('drives m5-mainline through one kill/restart to completion with every judgeable row passing', async () => {
    // AIO_JOINT_DRY_DIR keeps the run's private report and exports for review.
    const base = await mkdtemp(
      join(process.env.AIO_JOINT_DRY_DIR ?? tmpdir(), 'aio-joint-dry-'),
    );
    const home = join(base, 'home');
    await mkdir(home, { mode: 0o700 });
    const paths = {
      status: join(base, 'status.json'),
      report: join(base, 'report.json'),
      privateDir: join(base, 'exports'),
    };
    const report = await runDryRun(home, paths);

    expect(report.status).toBe('completed');
    // Exactly one kill: K at the first mul/sub mergePR, or K′ at the docs spawn.
    expect(report.killed).toBe(true);
    expect(['K', "K'"]).toContain(report.trigger);
    expect(report.restart.oldPid).not.toBe(report.restart.newPid);
    expect(report.restart.withinBudget).toBe(true);
    // Owner policy: the fake planner's split differs, so it is revised; the
    // escalated code-name answer is held, then given by the owner.
    expect(report.owner.splitRevised).toBe(1);
    expect(report.owner.conclusionApproved).toBe(1);
    expect(report.owner.escalation).toMatchObject({
      releasedBy: expect.stringMatching(/^(restart|timeout)$/),
    });
    expect(report.escalationAnsweredByOwner).toBe(true);
    expect(report.owner.handOffs).toEqual([]);
    expect(report.owner.finalGate).toBeDefined();

    // Restart assertions: nothing fails; the rest is n/a offline.
    const assertions = report.assertions as Json[];
    expect(assertions.filter((a) => a.status === 'fail')).toEqual([]);
    const pass = new Set(
      assertions.filter((a) => a.status === 'pass').map((a) => a.id),
    );
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 17])
      expect(pass.has(id)).toBe(true);

    // T10 checker on the masked export: every judgeable row passes.
    const rows = report.acceptance.rows as Json[];
    expect(rows.filter((r) => r.verdict === 'fail')).toEqual([]);
    for (const r of rows.filter((r) => r.verdict === 'na'))
      expect(DRY_RUN_NA[r.id], r.id).toBeDefined();
    for (const id of [
      'nf.latency',
      'nf.reliability',
      'nf.masking',
      'nf.merge-default-branch',
      'nf.stage-gate-agents',
      'v01.gates',
      'v01.oncall',
      'v01.base-sha',
      'v01.rework',
      'v01.integration-branch',
      'v01.waiting-input',
      'v01.replay',
      'x.no-duplicates',
    ])
      expect(rows.find((r) => r.id === id)?.verdict, id).toBe('pass');

    // B4: raw stays private (0600), the masked copy beside it.
    const files = await readdir(paths.privateDir);
    const raw = files.find((f) => f.endsWith('.raw.events.json'))!;
    expect((await stat(join(paths.privateDir, raw))).mode & 0o777).toBe(0o600);
    expect(files.some((f) => f.endsWith('.masked.events.json'))).toBe(true);
    // Fake-world janitor: nothing we created is left after the owner cleanup
    // (Issues stay open by design; the planner's untracked fake scratch
    // worktree is the fake runtime's own and is only reported).
    expect(report.janitor).toMatchObject({
      liveAgents: 0,
      workspaces: 0,
      openPrs: 0,
      workerBranches: 0,
    });
    expect(report.backendStop).toBe('ok');
    expect(JSON.parse(await readFile(paths.report, 'utf8')).status).toBe(
      'completed',
    );
  }, 120_000);
});
