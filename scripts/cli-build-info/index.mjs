import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Embeds the short commit into the CLI build so `ai-office --version` never runs git.
 * Without git (or outside a checkout) the commit is `unknown`.
 * @param {string} outDir
 * @param {() => string} [git]
 */
export function writeBuildInfo(
  outDir,
  git = () =>
    execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: outDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
) {
  let commit = 'unknown';
  try {
    const sha = git().trim();
    if (/^[0-9a-f]{4,40}$/.test(sha)) commit = sha;
  } catch {
    // No git or not a checkout.
  }
  writeFileSync(
    resolve(outDir, 'build-info.json'),
    JSON.stringify({ commit }) + '\n',
  );
  return commit;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  writeBuildInfo(resolve(process.argv[2] ?? 'dist'));
}
