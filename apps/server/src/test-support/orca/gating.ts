import { describe } from 'vitest';

export interface RealOrcaOptions {
  agents?: boolean;
  disruptive?: boolean;
}

/** Collection gate; the harness additionally verifies the actual origin before execution. */
export function realOrcaSkipReason(
  options: RealOrcaOptions,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.CI) return 'CI always skips real Orca tests';
  if (env.AIO_REAL_ORCA !== '1') return 'requires AIO_REAL_ORCA=1';
  if (options.agents && env.AIO_REAL_AGENTS !== '1')
    return 'requires AIO_REAL_AGENTS=1';
  if (options.disruptive)
    return 'disruptive tests require the interactive orca:p2 prepare command';
  if (!env.AIO_TEST_REPO_PATH) return 'requires AIO_TEST_REPO_PATH';
  return undefined;
}

export function realOrcaSuite(
  name: string,
  options: RealOrcaOptions,
  fn: () => void,
): void {
  const reason = realOrcaSkipReason(options);
  if (reason) {
    console.info(`[real Orca] ${name}: skipped (${reason})`);
    describe.skip(name, fn);
  } else {
    describe(name, fn);
  }
}
