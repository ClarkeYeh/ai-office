/**
 * M5-T11b runner scenario (`runHarnessCli record m5-t11b --scenario …`): the
 * real-agent preview of `m5-mainline` (M5_PLAN §2.5). Holds the Orca and
 * GitHub live locks for the whole run (T11's polls would see the spike's
 * `ai-office/` refs), drives the joint drill in `preview` mode, then adds the
 * final-branch checks (both operations, `node --test`) and writes the private
 * usage ledger for T13. The runner cleans the Orca ledger (janitor 0, scan 0)
 * and the stand-in's pushed branches through the harness ledger.
 *
 * LIVE ONLY: started by `acceptance/joint/preview.orca.test.ts` after the
 * coordinator's go; never in CI.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { OrcaHarness } from '../../orca/harness.js';
import { GITHUB_LOCK, ORCA_LOCK } from '../observe.js';
import { drill, holdLock, jointPathsFromEnv } from '../run.js';
import { conflictEquivalent, integrationBranch } from './facts.js';
import { previewMode } from './mode.js';
import { killSide, usageLedger } from './report.js';
import type { Json } from '../../orca/t17/checks.js';

const exec = promisify(execFile);

export const assertClean = true;

/** calc.mjs on the final integration head exports add, mul and sub. */
export const exportsAllOps = (source: string): boolean =>
  ['add', 'mul', 'sub'].every((name) =>
    new RegExp(`export\\s+(?:function\\s+${name}\\b|const\\s+${name}\\b)`).test(
      source,
    ),
  );

export async function run(h: OrcaHarness): Promise<void> {
  const paths = jointPathsFromEnv();
  const releaseOrca = await holdLock(ORCA_LOCK);
  try {
    const releaseGithub = await holdLock(GITHUB_LOCK);
    try {
      const mode = await previewMode(h);
      const report = await drill(mode, paths);
      const extra = await finalChecks(mode, report, paths.privateDir);
      Object.assign(report, extra);
      await writeFile(paths.report, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
    } finally {
      await releaseGithub();
    }
  } finally {
    await releaseOrca();
  }
}

async function finalChecks(
  mode: Awaited<ReturnType<typeof previewMode>>,
  report: Json,
  privateDir: string,
): Promise<Json> {
  const raw = (await readdir(privateDir)).find(
    (f) =>
      f.startsWith(`m5-joint-preview-${mode.tag}`) &&
      f.endsWith('.raw.events.json'),
  );
  const log: Json[] = raw
    ? (JSON.parse(await readFile(join(privateDir, raw), 'utf8')) as Json).events
    : [];
  const out: Json = {
    killSide: killSide(log, report.restart?.triggerSeq),
  };
  // T13 samples: numbers only, private (0600).
  await writeFile(
    join(privateDir, `usage-t11b-${mode.tag}.json`),
    JSON.stringify(usageLedger(log, mode.tag), null, 2),
    { mode: 0o600 },
  );
  out.conflictEquivalent = await conflictEquivalent(mode.git, log);
  const branch = integrationBranch(log);
  if (!branch) return out;
  await mode.fetch().catch(() => undefined);
  const dir = `m5/${mode.tag}`;
  const calc = await mode
    .git(['show', `origin/${branch}:${dir}/calc.mjs`])
    .catch(() => '');
  out.bothOps = exportsAllOps(calc);
  // §2.2.2 common condition: the final integration branch's tests pass.
  // Extracted with `git archive` (no worktree in the spike clone).
  const scratch = await mkdtemp(join(tmpdir(), 'aio-t11b-tests-'));
  try {
    const archive = join(scratch, 'tree.tar');
    await mode.git([
      'archive',
      '--format=tar',
      `--output=${archive}`,
      `origin/${branch}`,
      dir,
    ]);
    await exec('/usr/bin/tar', ['-xf', archive, '-C', scratch]);
    out.testsPass = await exec(process.execPath, ['--test', dir], {
      cwd: scratch,
      timeout: 120_000,
      env: { PATH: '/usr/bin:/bin', HOME: scratch },
    }).then(
      () => true,
      () => false,
    );
  } catch {
    out.testsPass = false;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return out;
}
