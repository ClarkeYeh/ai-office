import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { OrcaHarness } from './harness.js';
import { TEST_REPO_URL } from './safety.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(response: unknown) {
  const repo = await mkdtemp(join(tmpdir(), 'aio-rejection-'));
  dirs.push(repo);
  const harness = await OrcaHarness.create({
    repoPath: repo,
    sourceRoot: process.cwd(),
    orcaBin: '/synthetic/orca',
    worktreePaths: async () => [],
    env: { AIO_REAL_ORCA: '1' },
    exec: {
      run: async (r) => ({
        exitCode: r.bin === 'git' ? 0 : 1,
        stdout: r.bin === 'git' ? TEST_REPO_URL : JSON.stringify(response),
      }),
    },
  });
  dirs.push(harness.ledger.dataDir);
  harness.ledger.shims.push({ id: 'term_owned', done: false });
  await harness.persist();
  return harness;
}
const args = [
  'orchestration',
  'run-create',
  '--from',
  'term_owned',
  '--objective',
  'aio-test-rejection',
  '--retry-request',
  '00000000-0000-4000-8000-000000000001',
  '--json',
  '--full',
];
it('clears only an explicit request_mismatch intent and captures its code', async () => {
  const h = await fixture({ ok: false, error: { code: 'request_mismatch' } });
  expect(await h.command(args, 'request_mismatch')).toEqual({
    rejected: 'request_mismatch',
  });
  expect(h.ledger.pending).toEqual([]);
});
it.each([
  { ok: false, error: { code: 'outcome_unknown' } },
  {
    ok: false,
    error: {
      code: 'request_mismatch',
      residualResources: { dispatchId: 'ctx_unknown' },
    },
  },
  { ok: false },
  {
    ok: false,
    error: { code: 'request_mismatch' },
    result: { run: { id: 'run_residual' } },
  },
  { ok: true, result: {} },
])(
  'retains ambiguous mutation intent for the janitor: %j',
  async (response) => {
    const h = await fixture(response);
    await expect(h.command(args, 'request_mismatch')).rejects.toThrow();
    expect(h.ledger.pending).toHaveLength(1);
    await expect(h.clean()).rejects.toThrow('Unresolved mutation receipt');
  },
);
