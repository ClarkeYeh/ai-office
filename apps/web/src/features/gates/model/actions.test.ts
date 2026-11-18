import { expect, test } from 'vitest';
import {
  dependencyErrors,
  isRateLimited,
  optionAction,
  type WorkItemDraft,
} from './actions.js';
const item = (key: string, deps: string[] = []): WorkItemDraft => ({
  key,
  deps,
  title: key,
  body: '',
  acceptance: [],
  role: 'engineer',
});
test('dependencies allow a DAG and flag unknown, cyclic, self and duplicate keys', () => {
  expect(
    dependencyErrors([item('a'), item('b', ['a']), item('c', ['a', 'b'])]),
  ).toEqual([]);
  expect(dependencyErrors([item('a', ['missing'])])).toEqual(['missing']);
  expect(dependencyErrors([item('a', ['b']), item('b', ['a'])])).toEqual(['a']);
  expect(dependencyErrors([item('a', ['a'])])).toEqual(['a']);
  expect(dependencyErrors([item('a'), item('a')])).toEqual(['duplicate']);
});
test('option payloads validate each extra input without inventing actions', () => {
  expect(optionAction({ optionId: 'retry', label: 'Retry' }, '')).toEqual({
    decision: 'option',
    optionId: 'retry',
  });
  const tokens = {
    optionId: 'top-up',
    label: 'Top up',
    input: 'tokens' as const,
  };
  for (const value of [
    '',
    '0',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '9007199254740992',
  ])
    expect(optionAction(tokens, value)).toBeNull();
  expect(optionAction(tokens, '100')).toEqual({
    decision: 'option',
    optionId: 'top-up',
    additionalTokens: 100,
  });
  const agent = {
    optionId: 'reassign',
    label: 'Reassign',
    input: 'agent' as const,
  };
  expect(optionAction(agent, '')).toBeNull();
  expect(optionAction(agent, 'codex')?.agent).toBe('codex');
  expect(optionAction(agent, 'claude-code')?.agent).toBe('claude-code');
  const text = {
    optionId: 'explain',
    label: 'Explain',
    input: 'text' as const,
  };
  expect(optionAction(text, ' ')).toBeNull();
  expect(optionAction(text, ' answer ')?.comment).toBe('answer');
});
test('quota signal is optional, null clears it', () => {
  expect(isRateLimited(undefined)).toBe(false);
  expect(isRateLimited({})).toBe(false);
  expect(isRateLimited({ rateLimited: null })).toBe(false);
  expect(isRateLimited({ rateLimited: { since: 'now' } })).toBe(true);
});
