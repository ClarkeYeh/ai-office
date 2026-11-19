import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('applies explicit factory and disposal hook timeouts despite a 1 ms project default', async () => {
  const dir = await mkdtemp(join(import.meta.dirname, 'hook-probe-'));
  try {
    const path = join(dir, 'hooks.test.ts');
    await writeFile(
      path,
      `import { beforeEach } from 'vitest';
import { scmPortContract } from '../../scm-port-contract.js';
let skip;
beforeEach((context) => { skip = context.skip; }, 1000);
scmPortContract(async () => {
  await new Promise((r) => setTimeout(r, 20));
  return { repo: {owner:'synthetic',name:'synthetic'}, defaultBranch:'main',
    scm: new Proxy({}, {get: () => () => skip('synthetic hook probe')}),
    pushBranch: async () => skip(), editBody: async () => {},
    dispose: async () => { await new Promise((r) => setTimeout(r,20)); },
  };
}, { hookTimeoutMs: 1000 });
`,
    );
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        path,
        '--project',
        '@ai-office/server',
        '--hookTimeout=1',
        '--maxWorkers=2',
        '--reporter=json',
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      numFailedTests: number;
      numPendingTests: number;
    };
    expect(report.numFailedTests).toBe(0);
    expect(report.numPendingTests).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 35_000);
