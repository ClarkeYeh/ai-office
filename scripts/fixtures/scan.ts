import { safeWebEvents } from '../record-web-fixtures/scan-events.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import process from 'node:process';
import { fixtureRedactor } from './redaction.ts';

// Inspect decoded JSON strings, including escaped prose. Code-like identifiers,
// hashes and branches are not natural language; placeholders are exact matches.
export function hasLongNaturalText(value: unknown): boolean {
  if (typeof value === 'string')
    return (
      value.length > 80 &&
      !/^‹text len=\d+ sha=[a-f0-9]{12}›$/.test(value) &&
      /\s|[\u3400-\u9fff]/u.test(value)
    );
  if (Array.isArray(value)) return value.some(hasLongNaturalText);
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, item]) => hasLongNaturalText(key) || hasLongNaturalText(item),
    );
  return false;
}

function scan(
  directory: string,
  redactor: ReturnType<typeof fixtureRedactor>,
): number {
  const { maskText } = redactor;
  let failures = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      maskText(entry.name.replace(/\.(?:json|md)$/, '')) !==
      entry.name.replace(/\.(?:json|md)$/, '')
    )
      failures++;
    if (entry.isDirectory()) failures += scan(path, redactor);
    else if (!entry.isFile())
      failures++; // Never follow symlinks outside fixtures.
    else {
      const data = readFileSync(path);
      const text = data.toString('utf8');
      if (/\/(?:Users|home)\/[^/\s"]+/.test(text)) failures++;
      if (
        /term_(?!00000000-0000-4000-8000-)[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.test(
          text,
        )
      )
        failures++;
      if (!Buffer.from(text).equals(data) || text.includes('\0')) {
        failures++;
        continue;
      }
      if (entry.name.endsWith('.json')) {
        try {
          const value: unknown = JSON.parse(text);
          if (
            resolve(path).startsWith(resolve('fixtures/m5') + sep) &&
            hasLongNaturalText(value)
          )
            failures++;
          if (/\/(?:Users|home)\/[^/\s"]+/.test(JSON.stringify(value)))
            failures++;
          if (
            entry.name.endsWith('.events.json') &&
            resolve(dirname(path)) === resolve('fixtures/web')
          ) {
            if (!safeWebEvents(value, redactor)) failures++;
          } else if (resolve(path).startsWith(resolve('fixtures/m5') + sep)) {
            // Event fixtures preserve counters, including token-named fields.
            // Do not apply the generic body summarizer to B4 placeholders.
            const safe = (item: unknown): boolean => {
              if (typeof item === 'string')
                return (
                  /^‹text len=\d+ sha=[a-f0-9]{12}›$/.test(item) ||
                  (maskText(item) === item && !/aio_ctl_/.test(item))
                );
              if (Array.isArray(item)) return item.every(safe);
              if (item && typeof item === 'object')
                return Object.entries(item).every(
                  ([key, child]) => safe(key) && safe(child),
                );
              return true;
            };
            if (!safe(value)) failures++;
          } else if (fixtureRedactor(path).hasLeaks(value)) failures++;
        } catch {
          failures++;
        }
      } else if (
        entry.name.endsWith('.yaml') &&
        resolve(dirname(path)) === resolve('fixtures/web/templates')
      ) {
        if (maskText(text) !== text) failures++;
      } else if (entry.name === '.gitkeep') {
        if (text !== '') failures++;
      } else if (entry.name === 'README.md') {
        if (maskText(text) !== text) failures++;
      } else {
        // Recorded data must be JSON so body rules cannot be bypassed by renaming.
        failures++;
      }
    }
  }
  return failures;
}

try {
  if (process.argv.length > 3) throw new Error('Invalid arguments');
  const failures = scan(process.argv[2] ?? 'fixtures', fixtureRedactor());
  if (failures) throw new Error('Unsafe fixtures');
  process.stdout.write('Fixture scan passed.\n');
} catch {
  // Do not echo filenames, values, parser errors or absolute paths into CI logs.
  process.stderr.write(
    'Fixture scan failed: unsafe content, filename, format, or unreadable directory.\n',
  );
  process.exitCode = 1;
}
