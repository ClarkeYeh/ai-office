import { describe } from 'vitest';

/** Collection gate only; T7 must verify identity, repo, quota and live lock. */
export function realGithubSkipReason(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.CI !== undefined) return 'CI always skips real GitHub tests';
  if (env.AIO_REAL_GITHUB !== '1') return 'requires AIO_REAL_GITHUB=1';
  return undefined;
}

export function realGithubSuite(name: string, fn: () => void): void {
  const reason = realGithubSkipReason();
  if (reason) {
    console.info(`[real GitHub] ${name}: skipped (${reason})`);
    describe.skip(name, fn);
  } else {
    describe(name, fn);
  }
}
