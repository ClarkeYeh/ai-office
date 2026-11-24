import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkAcceptance,
  parseFacts,
} from '../../test-support/acceptance-check/index.js';
import { realOrcaSuite } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';
import { judgeAcceptance } from '../../test-support/joint/run.js';
import { behaviours } from '../../test-support/joint/preview/report.js';
import { PREVIEW_NA } from '../../test-support/joint/preview/mode.js';
import type { Json } from '../../test-support/orca/t17/checks.js';

/*
 * M5-T11b real-agent preview (M5_PLAN §2.5, §5 T11b): `--dev --runtime orca`
 * + scm-gitremote, real Claude and Codex agents, T8's `m5-mainline` text,
 * one backend `kill -9` at K (K′ fallback), the held escalation answer, the
 * §2.3.4 assertions (GitHub-only items by gitremote equivalents), the T10
 * checker and the §2.6 behaviour verdicts. LIVE ONLY, after the
 * coordinator's go, serially, under `caffeinate -i`, with Node 24 and
 * `pnpm -r build` first:
 *
 *   AIO_REAL_ORCA=1 AIO_REAL_AGENTS=1 AIO_TEST_REPO_PATH=<spike clone>
 *   AIO_ORCA_BIN=<orca> AIO_JOINT_STATUS=… AIO_JOINT_REPORT=…
 *   AIO_JOINT_PRIVATE_DIR=… pnpm test:orca:agents preview.orca.test.ts
 *
 * The scenario holds the Orca and GitHub live locks; the runner then cleans
 * the Orca ledger and the pushed branches and asserts janitor 0 / scan 0.
 */
realOrcaSuite('M5-T11b real-agent preview', { agents: true }, () => {
  it(
    'runs m5-mainline with real agents through one kill/restart up to the stand-in merge',
    async () => {
      await runHarnessCli([
        'record',
        'm5-t11b',
        '--scenario',
        fileURLToPath(
          new URL(
            '../../test-support/joint/preview/scenario.ts',
            import.meta.url,
          ),
        ),
      ]);
      // The T10 checker and §2.6 verdicts on the private exports.
      const reportPath = process.env.AIO_JOINT_REPORT!;
      const privateDir = process.env.AIO_JOINT_PRIVATE_DIR!;
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as Json;
      const files = await readdir(privateDir);
      const prefix = `m5-joint-preview-${report.tag}`;
      const read = async (suffix: string) =>
        JSON.parse(
          await readFile(
            join(
              privateDir,
              files.find((f) => f === prefix + suffix)!,
            ),
            'utf8',
          ),
        ) as Json;
      const masked = (await read('.masked.events.json')).events as Json[];
      const raw = (await read('.raw.events.json')).events as Json[];
      const checked = checkAcceptance(
        masked,
        parseFacts(await read('.facts.json')),
      );
      const acceptance = judgeAcceptance(checked, PREVIEW_NA);
      const verdicts = behaviours({
        log: raw,
        report,
        rows: Object.fromEntries(acceptance.rows.map((r) => [r.id, r.verdict])),
        conflictEvidence:
          checked.rows.find((r) => r.id === 'v01.conflict')?.evidence ?? [],
        conflictEquivalent: report.conflictEquivalent ?? null,
        ...(typeof report.testsPass === 'boolean'
          ? { testsPass: report.testsPass }
          : {}),
        ...(typeof report.bothOps === 'boolean'
          ? { bothOps: report.bothOps }
          : {}),
      });
      Object.assign(report, { acceptance, behaviours: verdicts });
      await writeFile(reportPath, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      console.info(
        `T11b report: ${reportPath}\n${JSON.stringify(
          verdicts.map((v) => [v.id, v.level, v.ok]),
        )}`,
      );
      // Musts are triaged (§2.6) from the report; the test fails loudly on any.
      expect(
        verdicts.filter((v) => v.level === 'must' && v.ok !== true),
      ).toEqual([]);
    },
    // Real agents: up to several hours, plus the 10-minute escalation hold.
    5 * 60 * 60_000,
  );
});
