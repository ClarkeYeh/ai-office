import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** @param {string} directory @returns {Promise<string[]>} */
export async function placeholders(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await placeholders(file)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      const source = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
        .trim();
      if (/^export\s*\{\s*\}\s*;?$/.test(source)) result.push(file);
    }
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(import.meta.dirname, '../..');
  // dependency-cruiser cannot resolve URL-based dynamic imports. Materialize the
  // same edges as the skeleton smoke tests for this cruise only. Implemented
  // modules stop matching, so the orphan rule still catches unused real code.
  const bridge = resolve(
    import.meta.dirname,
    `generated-skeleton-${process.pid}.test.ts`,
  );
  try {
    const files = [];
    for (const pkg of [
      'apps/server',
      'apps/web',
      'packages/contracts',
      'packages/domain',
      'packages/engine',
      'packages/projection',
    ]) {
      files.push(...(await placeholders(resolve(root, pkg, 'src'))));
    }
    await writeFile(
      bridge,
      files
        .sort()
        .map(
          (file) =>
            `import ${JSON.stringify(relative(import.meta.dirname, file).replaceAll('\\', '/'))};`,
        )
        .join('\n') + '\n',
      { flag: 'wx' },
    );
    const executable = new URL(
      '../../bin/dependency-cruiser.mjs',
      import.meta.resolve('dependency-cruiser'),
    );
    const result = spawnSync(
      process.execPath,
      [executable.pathname, '--config', '.dependency-cruiser.cjs', '.'],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await rm(bridge, { force: true });
  }
}
