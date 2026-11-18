import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { realOrcaSkipReason } from './gating.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const vitest = join(root, 'node_modules/vitest/vitest.mjs');

// Only starts Vitest with a synthetic test; never invokes Orca or a real suite.
function run(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [vitest, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}

describe('real Orca gates', () => {
  it('requires exact opt-in and always skips CI, even with all flags', () => {
    expect(realOrcaSkipReason({}, {})).toContain('AIO_REAL_ORCA');
    expect(realOrcaSkipReason({}, { AIO_REAL_ORCA: 'true' })).toBeDefined();
    expect(realOrcaSkipReason({}, { AIO_REAL_ORCA: '1' })).toBeUndefined();
    expect(
      realOrcaSkipReason({ agents: true }, { AIO_REAL_ORCA: '1' }),
    ).toContain('AIO_REAL_AGENTS');
    const enabled = { AIO_REAL_ORCA: '1', AIO_REAL_AGENTS: '1' };
    expect(realOrcaSkipReason({ agents: true }, enabled)).toBeUndefined();
    expect(realOrcaSkipReason({}, { ...enabled, CI: 'true' })).toContain('CI');
    expect(realOrcaSkipReason({}, { ...enabled, CI: 'false' })).toContain('CI');
    expect(realOrcaSkipReason({ disruptive: true }, enabled)).toContain(
      'M2-T8',
    );
  });

  it('excludes live files from default projects and skips their bodies without opt-in', () => {
    const directory = mkdtempSync(join(import.meta.dirname, 'gate-probe-'));
    const probe = join(directory, 'probe.orca.test.ts');
    writeFileSync(
      probe,
      `import { it } from 'vitest';
import { realOrcaSuite } from '../gating.js';
realOrcaSuite('synthetic live probe', {}, () => {
  it('must never execute', () => { throw new Error('live body executed'); });
});\n`,
    );
    try {
      const pkg = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
      ) as {
        scripts: Record<string, string>;
      };
      for (const script of ['test', 'test:coverage']) {
        expect(pkg.scripts[script]).toContain(
          "--project '!@ai-office/server-orca'",
        );
      }
      const files = run(
        [
          'list',
          '--filesOnly',
          '--json',
          '--project',
          '!@ai-office/server-orca',
        ],
        { CI: 'true', AIO_REAL_ORCA: '', AIO_REAL_AGENTS: '' },
      );
      expect(files).not.toContain('.orca.test.ts');
      for (const env of [
        { CI: '', AIO_REAL_ORCA: '', AIO_REAL_AGENTS: '' },
        { CI: 'true', AIO_REAL_ORCA: '1', AIO_REAL_AGENTS: '1' },
      ]) {
        const output = run(
          [
            'run',
            probe,
            '--project',
            '@ai-office/server-orca',
            '--reporter=json',
          ],
          env,
        );
        const report = JSON.parse(output) as {
          numPassedTests: number;
          numPendingTests: number;
          numFailedTests: number;
        };
        expect(report.numPassedTests).toBe(0);
        expect(report.numFailedTests).toBe(0);
        expect(report.numPendingTests).toBe(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
