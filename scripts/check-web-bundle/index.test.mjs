import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkWebBundle } from './index.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-bundle-'));
  try {
    await mkdir(join(directory, '.vite'));
    const manifest = { 'index.html': { file: 'app.js', isEntry: true } };
    const stats = {
      modules: ['/repo/apps/web/src/main.tsx'],
      chunks: ['app.js'],
    };
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
