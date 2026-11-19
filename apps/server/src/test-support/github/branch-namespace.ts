import { assertRunId } from './safety.js';

/** Production shortIds are at most 12 chars; the test prefix is 13 chars. */
export function githubBranches(runId: string, shortId?: string) {
  assertRunId(runId);
  if (shortId !== undefined && !/^[a-z0-9]{4,12}$/.test(shortId))
    throw new Error('Invalid workflow shortId');
  const test = `ai-office/t${runId}`;
  const original = shortId === undefined ? test : `ai-office/${shortId}`;
  const replace = (value: string, from: string, to: string) =>
    value.startsWith(from + '/') || value.startsWith(from + '-')
      ? to + value.slice(from.length)
      : value;
  return {
    remote: (branch: string) => replace(branch, original, test),
    logical: (branch: string) => replace(branch, test, original),
  };
}
