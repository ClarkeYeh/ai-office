import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
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
  const initial = new Set();
  /** @param {string} key */
  function visit(key) {
    if (initial.has(key)) return;
    assert(manifest[key], 'Missing static import: ' + key);
    initial.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  }
  for (const [key, entry] of Object.entries(manifest))
    if (entry.isEntry) visit(key);
  const jsFiles = new Set(
    [...initial]
      .map((key) => manifest[key].file)
      .filter((file) => /\.[cm]?js$/.test(file)),
  );
  let initialJsGzip = 0;
  for (const file of jsFiles)
    initialJsGzip += gzipSync(await readFile(join(directory, file))).length;
  assert(
    initialJsGzip <= 250_000,
    'Initial JS gzip budget exceeded: ' + initialJsGzip + ' > 250000',
  );
  let spritePng = 0;
  let fonts = 0;
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
    /apps\/server(?:\/|$)|(?:^|\/)(?:@octokit\/|octokit(?:\/|$)|better-sqlite3(?:\/|$))|node:|test-support\/harness/;
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
        const bytes = await readFile(file);
        if (/\.png$/i.test(file)) spritePng += bytes.length;
        if (/\.(woff2?|ttf|otf)$/i.test(file)) fonts += bytes.length;
        if (!/\.(?:[cm]?js|css|html|json)$/i.test(file)) continue;
        const text = bytes.toString('utf8');
        // Source metadata and license URLs are not browser resources. Scan emitted
        // code/styles/HTML for CDN and external-font hosts, and resource attributes.
        if (!file.includes('/.vite/')) {
          // Permit only inert framework/schema identifiers and GitHub link targets.
          // Other absolute network URLs require review rather than silently shipping.
          for (const match of text.matchAll(
            /https?:\/\/([a-z0-9.-]+)(?=[:/\s"'\x60<>]|$)/gi,
          )) {
            assert(
              [
                'react.dev',
                'www.w3.org',
                'json-schema.org',
                'github.com',
                'localhost',
                '127.0.0.1',
              ].includes(match[1]?.toLowerCase() ?? ''),
              'External resource URL in ' + file + ': ' + match[1],
            );
          }
          assert(
            !/(?:https?:)?\/\/(?:fonts\.(?:googleapis|gstatic)\.com|(?:[^/\s"']+\.)?(?:jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh))/i.test(
              text,
            ),
            'External font or CDN URL in ' + file,
          );
          if (/\.(css|html)$/i.test(file))
            assert(
              !/(?:url\(\s*["']?|@import\s+["']|(?:src|href)\s*=\s*["'])(?:https?:)?\/\//i.test(
                text,
              ),
              'External resource URL in ' + file,
            );
        }
        assert(
          !/child_process|orca orchestration/.test(text),
          `Forbidden string in ${file}`,
        );
      }
    }
  }
  await scan(directory);
  assert(
    spritePng <= 250_000,
    'Sprite PNG budget exceeded: ' + spritePng + ' > 250000',
  );
  assert(fonts <= 300_000, 'Font budget exceeded: ' + fonts + ' > 300000');
  console.log(
    'Bundle bytes: initial JS gzip=' +
      initialJsGzip +
      ', PNG=' +
      spritePng +
      ', fonts=' +
      fonts,
  );
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
