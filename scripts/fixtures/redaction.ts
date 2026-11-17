import { createRedactor } from '@ai-office/redaction';
import process from 'node:process';

// Fixture provenance configuration belongs to the caller, not the shared rules.
export function fixtureRedactor() {
  return createRedactor({
    preservedRepoUrls: (
      process.env.AIO_FIXTURE_REPO_URLS ??
      'https://github.com/ClarkeYeh/ai-office-spike'
    )
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
  });
}
