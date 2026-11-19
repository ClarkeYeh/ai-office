import { createRedactor } from '@ai-office/redaction';
import process from 'node:process';
import { resolve, sep } from 'node:path';
import { githubRefRedactor } from './github-redaction.ts';
import { isUsageFixture, preserveUsageCounters } from './usage-redaction.ts';

// Fixture provenance configuration belongs to the caller, not the shared rules.
export function fixtureRedactor(path?: string) {
  const redactor = createRedactor({
    preservedRepoUrls: (
      process.env.AIO_FIXTURE_REPO_URLS ??
      'https://github.com/ClarkeYeh/ai-office-spike'
    )
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
  });
  if (path && resolve(path).startsWith(resolve('fixtures/github') + sep))
    return githubRefRedactor(redactor);
  if (!isUsageFixture(path)) return redactor;
  const sanitize = (value: unknown): unknown =>
    preserveUsageCounters(value, redactor.sanitize(value));
  return {
    ...redactor,
    sanitize,
    hasLeaks: (value: unknown) =>
      JSON.stringify(value) !== JSON.stringify(sanitize(value)),
  };
}
