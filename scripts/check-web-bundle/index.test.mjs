import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkWebBundle } from './index.mjs';

/**
 * @typedef {{ directory: string, manifest: Record<string, { file: string, isEntry: boolean }>, stats: { modules: string[], chunks: string[] }, json: (name: string, value: unknown) => Promise<void> }} Fixture
 * @param {(fixture: Fixture) => Promise<void>} run
 */
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-bundle-'));
  try {
    await mkdir(join(directory, '.vite'));
    const manifest = { 'index.html': { file: 'app.js', isEntry: true } };
    const stats = {
      modules: ['/repo/apps/web/src/main.tsx'],
      chunks: ['app.js'],
    };
    /** @param {string} name @param {unknown} value */
    const json = (name, value) =>
      writeFile(join(directory, '.vite', name), JSON.stringify(value));
    await json('manifest.json', manifest);
    await json('module-stats.json', stats);
    await writeFile(join(directory, 'app.js'), 'console.log("safe");');
    await run({ directory, manifest, stats, json });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts a complete clean bundle', () =>
  fixture(async ({ directory }) => {
    assert.equal(await checkWebBundle(directory), 1);
  }));
for (const id of [
  '/repo/apps/server/src/main.ts',
  '/repo/node_modules/octokit/dist/index.js',
  '/repo/node_modules/@octokit/core/dist/index.js',
  '/repo/node_modules/better-sqlite3/index.js',
  'node:fs',
  'C:\\repo\\apps\\server\\src\\main.ts',
]) {
  test(`rejects module ${id}`, () =>
    fixture(async ({ directory, stats, json }) => {
      stats.modules.push(id);
      await json('module-stats.json', stats);
      await assert.rejects(checkWebBundle(directory), /Forbidden web module/);
    }));
}
for (const text of ['child_process', 'orca orchestration']) {
  test(`rejects output string ${text}`, () =>
    fixture(async ({ directory }) => {
      await writeFile(join(directory, 'app.js'), text);
      await assert.rejects(checkWebBundle(directory), /Forbidden string/);
    }));
}
test('fails closed without module stats', () =>
  fixture(async ({ directory }) => {
    await rm(join(directory, '.vite/module-stats.json'));
    await assert.rejects(checkWebBundle(directory), /ENOENT/);
  }));
test('fails closed for empty module stats', () =>
  fixture(async ({ directory, stats, json }) => {
    stats.modules = [];
    await json('module-stats.json', stats);
    await assert.rejects(
      checkWebBundle(directory),
      /Missing Rollup module list/,
    );
  }));
test('rejects a stale manifest/stats pair', () =>
  fixture(async ({ directory, stats, json }) => {
    stats.chunks = ['old.js'];
    await json('module-stats.json', stats);
    await assert.rejects(checkWebBundle(directory), /Stats missing/);
  }));

const oversized = /** @type {[string, number, RegExp][]} */ ([
  ['sprites.png', 250001, /Sprite PNG budget/],
  ['font.woff2', 300001, /Font budget/],
]);
for (const [file, size, message] of oversized) {
  test(`rejects oversized ${file}`, () =>
    fixture(async ({ directory }) => {
      await writeFile(join(directory, file), Buffer.alloc(size));
      await assert.rejects(checkWebBundle(directory), message);
    }));
}
const resources = /** @type {[string, string][]} */ ([
  ['styles.css', '@font-face{src:url(https://example.org/font.woff2)}'],
  ['styles.css', '@import "//example.org/theme.css";'],
  ['index.html', '<script src="https://example.org/main.js"></script>'],
  ['app.js', 'const url="https://cdn.jsdelivr.net/npm/example";'],
]);
for (const [file, source] of resources) {
  test(`rejects external resource in ${file}: ${source}`, () =>
    fixture(async ({ directory }) => {
      await writeFile(join(directory, file), source);
      await assert.rejects(checkWebBundle(directory), /External/);
    }));
}
test('rejects production scene harness', () =>
  fixture(async ({ directory, stats, json }) => {
    stats.modules.push('/repo/apps/web/src/test-support/harness/main.tsx');
    await json('module-stats.json', stats);
    await assert.rejects(checkWebBundle(directory), /Forbidden web module/);
  }));
test('counts static imports but not lazy chunks in the initial JS budget', () =>
  fixture(async ({ directory, manifest, stats, json }) => {
    const { randomBytes } = await import('node:crypto');
    await writeFile(join(directory, 'large.js'), randomBytes(300000));
    stats.chunks.push('large.js');
    await json('module-stats.json', stats);
    const lazy = {
      ...manifest,
      lazy: { file: 'large.js', isDynamicEntry: true },
    };
    await json('manifest.json', lazy);
    await checkWebBundle(directory);
    await json('manifest.json', {
      ...lazy,
      'index.html': { ...manifest['index.html'], imports: ['lazy'] },
    });
    await assert.rejects(checkWebBundle(directory), /Initial JS gzip budget/);
  }));
