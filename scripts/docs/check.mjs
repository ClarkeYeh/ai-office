import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRedactor } from '@ai-office/redaction';

// Docs may name the local backend and the apps they install; only the host part is
// exempted, so paths, queries and every other host, IP or email are still scanned.
const LOOPBACK =
  /(?<![\w.@-])(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?![\w-]|\.[\w-])/g;
const APP_NAMES = /(?<![\w.@-])Orca\.app(?![\w-]|\.[\w-])/g;
/** @param {string} root */
export function checkDocs(root = process.cwd()) {
  if (
    execFileSync('git', ['ls-files', '-z', '--', 'docs'], { cwd: root }).length
  )
    throw new Error('Private docs are tracked');
  const redactor = createRedactor({
    preservedRepoUrls: [
      'https://lospec.com/palette-list/endesga-32',
      'https://github.com/fontworks-fonts/DotGothic16',
      'https://github.com/ClarkeYeh/ai-office',
      'https://github.com/ClarkeYeh/ai-office-spike',
    ],
  });
  /** @param {string} directory @returns {string[]} */
  function files(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Guide symlink refused');
      return entry.isDirectory() ? files(file) : [file];
    });
  }
  for (const file of [
    resolve(root, 'README.md'),
    ...files(resolve(root, 'guide')),
  ]) {
    const text = readFileSync(file, 'utf8');
    const targets = [
      ...text.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+[^)]*)?\)/g),
      ...text.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm),
      ...text.matchAll(/(?:href|src)=["']([^"']+)["']/g),
    ];
    let scanText = text
      .replace(LOOPBACK, '<loopback>')
      .replace(APP_NAMES, '<app>');
    for (const match of targets) {
      const url = (match[1] ?? '').replace(/^<|>$/g, '');
      if (/^https:\/\//i.test(url) && redactor.maskText(url) === url)
        scanText = scanText.replace(match[1] ?? '', '<public-link>');
    }
    if (
      redactor.maskText(scanText) !== scanText ||
      /aio_ctl_[A-Za-z0-9_-]+/.test(scanText)
    )
      throw new Error('Unsafe public documentation');
    for (const match of targets) {
      const target = (match[1] ?? '').replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      const path = decodeURIComponent(target.split(/[?#]/)[0] ?? '');
      if (!path) continue;
      const destination = resolve(
        path.startsWith('/') ? root : dirname(file),
        path.replace(/^\//, ''),
      );
      const local = relative(root, destination);
      if (local === 'docs' || local.startsWith('docs' + sep))
        throw new Error('Link to private docs');
      if (!existsSync(destination))
        throw new Error('Broken documentation link');
      const actual = relative(realpathSync(root), realpathSync(destination));
      if (
        actual === '..' ||
        actual.startsWith('..' + sep) ||
        actual === 'docs' ||
        actual.startsWith('docs' + sep)
      )
        throw new Error('Documentation link escapes public repository');
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    checkDocs();
    console.log('Public documentation check passed.');
  } catch {
    console.error(
      'Public documentation check failed: tracked private docs, unsafe text, or invalid link.',
    );
    process.exitCode = 1;
  }
}
