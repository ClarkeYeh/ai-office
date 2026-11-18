import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { placeholders } from './index.mjs';

test('discovers nested placeholders and retires implemented modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-office-skeleton-'));
  try {
    await mkdir(join(directory, 'nested'));
    const placeholder = join(directory, 'nested/index.ts');
    await writeFile(placeholder, '// foundation\n/* empty */\nexport {};\n');
    await writeFile(
      join(directory, 'implemented.ts'),
      'export const value = 1;',
    );
    await writeFile(join(directory, 'ignored.test.ts'), 'export {};');
    assert.deepEqual(await placeholders(directory), [placeholder]);
    await writeFile(placeholder, 'export function decide() { return []; }');
    assert.deepEqual(await placeholders(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
