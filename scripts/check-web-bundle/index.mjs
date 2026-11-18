import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

/** @param {string} directory */
export async function checkWebBundle(directory) {
  /** @param {string} file */
  const readJSON = async (file) =>
    JSON.parse(await readFile(join(directory, file), 'utf8'));
  const manifest = await readJSON('.vite/manifest.json');
  const stats = await readJSON('.vite/module-stats.json');
  assert(
    Array.isArray(stats.modules) && stats.modules.length > 0,
    'Missing Rollup module list',
  );
  assert(
    Array.isArray(stats.chunks) && stats.chunks.length > 0,
    'Missing Rollup chunks',
  );
  const entries = Object.values(manifest);
  assert(
    entries.some((entry) => entry.isEntry),
    'Missing Vite entry',
  );
  for (const entry of entries) {
    assert(typeof entry.file === 'string', 'Invalid manifest file');
    await readFile(join(directory, entry.file));
    if (/\.[cm]?js$/.test(entry.file))
      assert(stats.chunks.includes(entry.file), `Stats missing ${entry.file}`);
  }
  for (const chunk of stats.chunks) await readFile(join(directory, chunk));
  const forbiddenModule =
    /apps\/server(?:\/|$)|(?:^|\/)(?:@octokit\/|octokit(?:\/|$)|better-sqlite3(?:\/|$))|node:/;
  for (const id of [...stats.modules, ...Object.keys(manifest)]) {
    assert(typeof id === 'string', 'Invalid module ID');
    assert(
      !forbiddenModule.test(id.replaceAll('\\', '/')),
      `Forbidden web module: ${id}`,
    );
  }
  /** @param {string} dir @returns {Promise<void>} */
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else {
        const text = await readFile(file, 'utf8');
        assert(
          !/child_process|orca orchestration/.test(text),
          `Forbidden string in ${file}`,
        );
      }
    }
  }
  await scan(directory);
  return stats.modules.length;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const directory = resolve(process.argv[2] ?? 'apps/web/dist');
  try {
    console.log(`Web bundle OK (${await checkWebBundle(directory)} modules).`);
  } catch (error) {
    console.error(
      `Web bundle check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
