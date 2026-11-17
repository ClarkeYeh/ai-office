import { describe, expect, it } from 'vitest';
import { mergeQueue } from './mainline-actions.js';
import type { ScenarioContext } from './scenario.js';

const send = (body: string) => {
  const script = mergeQueue.send;
  if (typeof script !== 'function') throw new Error('send is a function');
  return script({
    message: { subject: 'Review feature', body },
  } as ScenarioContext);
};

describe('stock merge-queue role', () => {
  it('requests the merge of the reviewed PR at its head SHA', () => {
    expect(send(JSON.stringify({ pr: 4, headSha: 'a'.repeat(40) }))).toEqual([
      expect.objectContaining({
        type: 'submit',
        submission: {
          kind: 'merge-request',
          payload: { pr: 4, expectedHeadSha: 'a'.repeat(40) },
        },
      }),
      expect.objectContaining({ type: 'done' }),
    ]);
  });
  it.each([
    'Merge failed (pr_not_mergeable). Resolve the worker branch, verify it, and submit merge-request with its new head SHA, or request a decision.',
    '{"note":"budget reminder"}',
    '',
  ])(
    'acknowledges prose and non-review messages without submitting (%j)',
    (body) => {
      expect(send(body)).toEqual([expect.objectContaining({ type: 'done' })]);
    },
  );
});
