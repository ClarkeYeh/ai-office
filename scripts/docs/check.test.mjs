import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkDocs, headingAnchor } from './check.mjs';
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

const anchorDocs = [
  '[Run](usage.md#4-start-the-backend-and-open-the-office)',
  '[Step](#step-2-check-the-installed-version-and-commit)',
  '[Ref][r]\n\n[r]: usage.md#12-run-the-first-workflow-on-the-spike-repo',
  // FX-TAIL: plain a–f words and short numbers are still slug words.
  '[Add](#add-a-face-to-the-office-in-2026)',
];
const anchorSecrets = [
  '[Run](usage.md#a1b2c3d4e5f6a7b8c9d0e1f2-start)',
  '[Run](usage.md#start-ghp_synthetic1234567890abcd)',
  'Text #4-start-the-backend aio_ctl_synthetic_secret',
  // FX-TAIL: exempted by #214's shape alone; scanned (and flagged) now.
  '[Run](usage.md#550e8400-e29b-41d4-a716-446655440000-start)',
  '[Run](#k9f2q-8w4x7-r1m3p-6z5t8-h2n7q)',
  '[Run](#ghp1234abcd-wxyz5678-qrst9012-mnop)',
];
for (const { name, sources, safe } of [
  { name: 'long heading anchors with digits pass', sources: anchorDocs, safe: true },
  { name: 'secrets in anchors still fail', sources: anchorSecrets, safe: false },
]) {
  test(`public docs: ${name}`, () => {
    for (const source of sources) {
      const root = mkdtempSync(join(tmpdir(), 'aio-docs-'));
      try {
        execFileSync('git', ['init', '-q', root]);
        mkdirSync(join(root, 'guide'));
        writeFileSync(join(root, 'guide/usage.md'), 'Usage.');
        writeFileSync(join(root, 'guide/index.md'), source);
        writeFileSync(join(root, 'README.md'), 'Public.');
        if (safe) checkDocs(root);
        else assert.throws(() => checkDocs(root), source);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

test('public docs: only word slugs skip the scan; UUID-like anchors do not (FX-TAIL)', () => {
  for (const url of [
    'usage.md#4-start-the-backend-and-open-the-office',
    '#step-2-check-the-installed-version-and-commit',
    '#add-a-face-to-the-office-in-2026',
  ])
    assert.equal(headingAnchor(url), true, url);
  // A bare UUID is not a secret to the redactor, but it is never exempted.
  for (const url of [
    'usage.md#550e8400-e29b-41d4-a716-446655440000',
    '#4f9a2c71-8e03-4b6d-9a15-c2e7f08b3d46',
    '#550e8400-e29b-41d4-a716-446655440000-start',
    '#add-face-bead',
    '#12345-start',
    '#v0-start',
  ])
    assert.equal(headingAnchor(url), false, url);
});
