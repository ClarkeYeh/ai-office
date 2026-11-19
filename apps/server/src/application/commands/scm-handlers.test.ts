import { expect, test, vi } from 'vitest';
import type { RuntimePort } from '../../ports/runtime.js';
import type { ScmPort } from '../../ports/scm.js';
import type { SpecStore } from '../../ports/stores.js';
import { portHandlers } from './executor.js';
import type { HandlerContext } from './executor.js';

const repo = { owner: 'o', name: 'r' };
const handlers = (scm: Partial<ScmPort>) =>
  portHandlers({
    runtime: {} as RuntimePort,
    scm: scm as ScmPort,
    specStore: {} as SpecStore,
  });
const ctx = {} as HandlerContext;

test('scm.deleteComment deletes the one comment on its target (CP1)', async () => {
  const deleteComment = vi.fn(async () => {});
  const result = await handlers({ deleteComment })['scm.deleteComment']!(
    { target: { repo, number: 4, type: 'issue' }, commentId: 'c-9' },
    ctx,
  );
  expect(result).toEqual({});
  expect(deleteComment).toHaveBeenCalledExactlyOnceWith(
    { repo, number: 4 },
    'c-9',
  );
});

test('scm.mergePR forwards expectedBaseSha only when recorded', async () => {
  const mergePR = vi.fn(async () => ({ mergeCommitSha: 'f'.repeat(40) }));
  const merge = handlers({ mergePR })['scm.mergePR']!;
  const pr = { repo, number: 2 };
  const base = {
    pr,
    method: 'merge' as const,
    expectedHeadSha: 'a'.repeat(40),
  };
  await merge(base, ctx);
  await merge({ ...base, expectedBaseSha: 'b'.repeat(40) }, ctx);
  expect(mergePR.mock.calls).toEqual([
    [pr, { method: 'merge', expectedHeadSha: 'a'.repeat(40) }],
    [
      pr,
      {
        method: 'merge',
        expectedHeadSha: 'a'.repeat(40),
        expectedBaseSha: 'b'.repeat(40),
      },
    ],
  ]);
});
