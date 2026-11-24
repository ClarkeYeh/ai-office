import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkDocs } from './check.mjs';
for (const scenario of [
  'good',
  'broken',
  'private',
  'tracked',
  'secret',
  'reference',
  'html',
]) {
  test(`public docs: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'aio-docs-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'guide'));
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'guide/index.md'), 'Public guide.');
      writeFileSync(join(root, 'docs/private.md'), 'Local.');
      const source = {
        good: '[Guide](guide/index.md)',
        broken: '[Missing](gone.md)',
        private: '[Local](docs/private.md)',
        tracked: 'Public.',
        secret: 'aio_ctl_synthetic_secret',
        reference: '[Guide][g]\n[g]: gone.md',
        html: '<a href="gone.md">Guide</a>',
      }[scenario];
      writeFileSync(join(root, 'README.md'), source ?? '');
      if (scenario === 'tracked')
        execFileSync('git', ['add', 'docs'], { cwd: root });
      if (scenario === 'good') checkDocs(root);
      else assert.throws(() => checkDocs(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
