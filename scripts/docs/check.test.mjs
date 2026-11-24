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

const loopbackDocs = [
  'Open http://127.0.0.1:4319/auth/bootstrap?code=<code> in a browser.',
  'The backend listens on `127.0.0.1` (default port 4319).',
  'Visit http://localhost:4319/workflows/<id>/timeline or localhost.',
  'Look in `/Applications/Orca.app/Contents/Resources/bin/orca`.',
];
const unsafeDocs = [
  'Open http://10.0.0.5:4319/ instead.',
  'The backend at 192.168.1.20 answers.',
  'See http://build.internal:8080/status for details.',
  'Mail someone@example.com for access.',
  'Ask admin@localhost for access.',
  'Try http://localhost.attacker.example/x too.',
  'Open http://127.0.0.1:4319/x?t=aio_ctl_synthetic_secret now.',
];
for (const { name, sources, safe } of [
  { name: 'loopback and app names pass', sources: loopbackDocs, safe: true },
  { name: 'other hosts, IPs and emails fail', sources: unsafeDocs, safe: false },
]) {
  test(`public docs: ${name}`, () => {
    for (const source of sources) {
      const root = mkdtempSync(join(tmpdir(), 'aio-docs-'));
      try {
        execFileSync('git', ['init', '-q', root]);
        mkdirSync(join(root, 'guide'));
        writeFileSync(join(root, 'guide/usage.md'), source);
        writeFileSync(join(root, 'README.md'), 'Public.');
        if (safe) checkDocs(root);
        else assert.throws(() => checkDocs(root), source);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}
