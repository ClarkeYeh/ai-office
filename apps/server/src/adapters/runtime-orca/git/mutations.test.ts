import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DefaultGitCli } from './index.js';
import { CwdGuard } from '../cli/cwd.js';
import type { ExecRequest } from '../cli/types.js';
const sha = 'a'.repeat(40),
  dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'aio-git-'));
  dirs.push(dir);
  const run = vi.fn<
    (req: ExecRequest) => Promise<{ stdout: string; exitCode: number | null }>
  >(async () => ({
    stdout: '',
    exitCode: 0 as number | null,
  }));
  const git = new DefaultGitCli({
    exec: { run },
    cwdGuard: new CwdGuard(dir, async () => []),
    env: {
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '1',
      ORCA_TERMINAL_HANDLE: 'must-not-pass',
    },
  });
  return { git, run };
}
it('forces noninteractive fetch and creates branches with no tracking', async () => {
  const { git, run } = await fixture();
  await git.fetch('/repo', 'main');
  await git.createBranch('/repo', 'ai-office/work', sha);
  expect(run.mock.calls[0]![0].env).toEqual({
    PATH: '/bin',
    GIT_TERMINAL_PROMPT: '0',
  });
  expect(run.mock.calls[1]![0].args).toEqual([
    '-C',
    '/repo',
    'branch',
    '--no-track',
    'ai-office/work',
    sha,
  ]);
});
it('resets only unoccupied, pushed branches', async () => {
  const { git, run } = await fixture();
  run.mockImplementation(async (req) => ({
    stdout: req.args.includes('worktree')
      ? 'worktree /occupied\0branch refs/heads/ai-office/work\0'
      : '',
    exitCode: 0,
  }));
  await expect(
    git.resetBranch('/repo', 'ai-office/work', sha),
  ).rejects.toMatchObject({ code: 'branch_in_use' });
  run.mockImplementation(async (req) => ({
    stdout: '',
    exitCode: req.args.includes('merge-base') ? 1 : 0,
  }));
  await expect(
    git.resetBranch('/repo', 'ai-office/work', sha),
  ).rejects.toMatchObject({ code: 'unpushed_commits' });
  run.mockResolvedValue({ stdout: '', exitCode: 0 });
  await git.resetBranch('/repo', 'ai-office/work', sha);
  expect(run.mock.calls.at(-1)![0].args).toEqual([
    '-C',
    '/repo',
    'branch',
    '-f',
    'ai-office/work',
    sha,
  ]);
});
it('deletes a receipt-proven local branch only at its unchanged tip without requiring a remote', async () => {
  const { git, run } = await fixture();
  run.mockImplementation(async (req) => ({
    stdout: req.args.includes('rev-parse') ? sha : '',
    exitCode: 0,
  }));
  await git.deleteCreatedBranch('/repo', 'aio-temp', sha);
  expect(run.mock.calls.at(-1)![0].args).toEqual([
    '-C',
    '/repo',
    'branch',
    '-D',
    'aio-temp',
  ]);
  run.mockImplementation(async (req) => ({
    stdout: req.args.includes('rev-parse') ? 'b'.repeat(40) : '',
    exitCode: 0,
  }));
  await expect(
    git.deleteCreatedBranch('/repo', 'aio-temp', sha),
  ).rejects.toMatchObject({ code: 'unpushed_commits' });
});
it('checkout -B refuses occupied or unpushed W', async () => {
  const { git, run } = await fixture();
  run.mockImplementation(async (req) => ({
    stdout: req.args.includes('rev-parse') ? sha : '',
    exitCode: req.args.includes('merge-base') ? 1 : 0,
  }));
  await expect(
    git.checkoutBranch('/receipt/path', 'ai-office/work', sha),
  ).rejects.toMatchObject({ code: 'unpushed_commits' });
  run.mockImplementation(async (req) => ({
    stdout: req.args.includes('rev-parse') ? sha : '',
    exitCode: 0,
  }));
  await git.checkoutBranch('/receipt/path', 'ai-office/work', sha);
  expect(run.mock.calls.at(-1)![0].args).toEqual([
    '-C',
    '/receipt/path',
    'checkout',
    '-B',
    'ai-office/work',
    sha,
  ]);
});
