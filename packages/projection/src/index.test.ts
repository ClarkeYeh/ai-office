import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

// Implemented modules leave this smoke test automatically; their own tests take over.
test('remaining placeholder modules can be loaded', async () => {
  async function visit(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(
        entry.name + (entry.isDirectory() ? '/' : ''),
        directory,
      );
      if (entry.isDirectory()) await visit(url);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const source = (await readFile(url, 'utf8'))
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
          .trim();
        if (/^export\s*\{\s*\}\s*;?$/.test(source)) {
          expect(await import(url.href)).toBeDefined();
        }
      }
    }
  }
  await visit(new URL('./', import.meta.url));
});
