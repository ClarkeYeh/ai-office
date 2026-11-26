import { readFileSync } from 'node:fs';
import type { CliResult } from './submit.js';

/**
 * The version comes from the package next to the build; the commit is embedded at build
 * time (`dist/build-info.json`). No git call at runtime: missing data reads `unknown`.
 */
export function version(directory = new URL('.', import.meta.url)): CliResult {
  const read = (name: string, key: string, valid: RegExp): string => {
    try {
      const value: unknown = JSON.parse(
        readFileSync(new URL(name, directory), 'utf8'),
      )[key];
      return typeof value === 'string' && valid.test(value) ? value : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const semver = read('../package.json', 'version', /^\d+\.\d+\.\d+\S*$/);
  const commit = read('build-info.json', 'commit', /^[0-9a-f]{4,40}$/);
  return { exitCode: 0, message: `ai-office ${semver} (commit ${commit})` };
}
