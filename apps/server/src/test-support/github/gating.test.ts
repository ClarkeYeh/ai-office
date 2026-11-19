import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { realGithubSkipReason } from './gating.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
function run(args: string[], flags: NodeJS.ProcessEnv) {
  const env = { ...process.env, ...flags };
  if (flags.CI === undefined) delete env.CI;
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), ...args, '--maxWorkers=2'],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}

describe('real GitHub gates', () => {
  it('requires exact opt-in and always skips when CI is set', () => {
    expect(realGithubSkipReason({})).toContain('AIO_REAL_GITHUB');
    expect(realGithubSkipReason({ AIO_REAL_GITHUB: 'true' })).toBeDefined();
    expect(realGithubSkipReason({ AIO_REAL_GITHUB: '1' })).toBeUndefined();
    for (const CI of ['', 'true', 'false', '1']) {
      expect(realGithubSkipReason({ AIO_REAL_GITHUB: '1', CI })).toContain(
        'CI',
      );
    }
  });

  it('isolates live files and skips their test bodies without authorization', () => {
    const directory = mkdtempSync(join(import.meta.dirname, 'gate-probe-'));
    const probe = join(directory, 'probe.github.test.ts');
    writeFileSync(
      probe,
      `import { it } from 'vitest';
import { realGithubSuite } from '../gating.js';
realGithubSuite('synthetic GitHub probe', () => {
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
          "--project '!@ai-office/server-github'",
        );
        expect(pkg.scripts[script]).toContain(
          "--project '!@ai-office/server-orca'",
        );
      }
      // Even excluding only the GitHub project must remove every GitHub live file.
      const files = run(
        [
          'list',
          '--filesOnly',
          '--json',
          '--project',
          '!@ai-office/server-github',
        ],
        { CI: 'true', AIO_REAL_GITHUB: '1' },
      );
      expect(files).not.toContain('.github.test.ts');
      const liveFiles = run(
        [
          'list',
          '--filesOnly',
          '--json',
          '--project',
          '@ai-office/server-github',
        ],
        { CI: 'true', AIO_REAL_GITHUB: '1' },
      );
      expect(liveFiles).toContain('probe.github.test.ts');
      expect(liveFiles).not.toContain('.orca.test.ts');
      for (const flags of [
        { CI: undefined, AIO_REAL_GITHUB: '' },
        { CI: 'true', AIO_REAL_GITHUB: '1' },
        { CI: '', AIO_REAL_GITHUB: '1' },
      ]) {
        const report = JSON.parse(
          run(
            [
              'run',
              probe,
              '--project',
              '@ai-office/server-github',
              '--reporter=json',
            ],
            flags,
          ),
        ) as {
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
