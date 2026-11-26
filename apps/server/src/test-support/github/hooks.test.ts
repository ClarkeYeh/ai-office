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

it('reports persistence failures after later cases and every cleanup have run', async () => {
  const dir = await mkdtemp(join(import.meta.dirname, 'hook-probe-'));
  try {
    const path = join(dir, 'persistence.test.ts');
    await writeFile(
      path,
      `import { afterAll, afterEach, expect, it } from 'vitest';
import { PersistenceFailures } from '../persistence-failures.js';
const failures = new PersistenceFailures();
const cleaned = [];
const saved = [];
afterEach(async ({task}) => {
  cleaned.push(task.name);
  await failures.capture(task.name, async () => {
    if (task.name !== 'third') throw new Error('private error must not be logged');
    saved.push(task.name);
  });
});
it('first', () => {});
it('second', () => {});
it('third', () => {});
afterAll(() => {
  expect(cleaned).toEqual(['first', 'second', 'third']);
  expect(saved).toEqual(['third']);
  failures.assertSuccess();
});
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
        '--maxWorkers=2',
        '--reporter=json',
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      numPassedTests: number;
      numPendingTests: number;
    };
    expect(report.numPassedTests).toBe(3);
    expect(report.numPendingTests).toBe(0);
    expect(result.stdout).toContain(
      'Tape persistence failed for 2 case(s): first [unclassified persistence refusal], second [unclassified persistence refusal]',
    );
    expect(result.stdout + result.stderr).not.toContain(
      'private error must not be logged',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 35_000);

it('strict replay fails a missing poll tape instead of silently skipping it', async () => {
  const dir = await mkdtemp(join(import.meta.dirname, 'hook-probe-'));
  try {
    const path = join(dir, 'strict.test.ts');
    await writeFile(
      path,
      `import { vi } from 'vitest';
vi.mock('node:fs', () => ({ existsSync: () => false }));
import { githubContract } from '../contract-binding.js';
githubContract('replay', () => { throw new Error('must not call adapter'); });
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
        '-t',
        'polls only changes and replays an uncommitted cursor',
        '--maxWorkers=2',
        '--reporter=json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, AIO_STRICT_REPLAY: '1' },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Missing required live contract recording');
    expect(result.stdout).not.toContain('must not call adapter');
    expect(
      (JSON.parse(result.stdout) as { numFailedTests: number }).numFailedTests,
    ).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 35_000);
