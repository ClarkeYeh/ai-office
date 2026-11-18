import { describe } from 'vitest';

export interface RealOrcaOptions {
  agents?: boolean;
  disruptive?: boolean;
}

/** Flag gate only; M2-T8 adds test-repo validation and resource ownership checks. */
export function realOrcaSkipReason(
  options: RealOrcaOptions,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.CI) return 'CI always skips real Orca tests';
  if (env.AIO_REAL_ORCA !== '1') return 'requires AIO_REAL_ORCA=1';
  if (options.agents && env.AIO_REAL_AGENTS !== '1')
    return 'requires AIO_REAL_AGENTS=1';
  if (options.disruptive)
    return 'disruptive tests are not available until M2-T8';
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
