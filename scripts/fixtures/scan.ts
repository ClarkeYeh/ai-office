import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fixtureRedactor } from './redaction.ts';

function scan(
  directory: string,
  redactor: ReturnType<typeof fixtureRedactor>,
): number {
  const { maskText, hasLeaks } = redactor;
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
      if (!Buffer.from(text).equals(data) || text.includes('\0')) {
        failures++;
        continue;
      }
      if (entry.name.endsWith('.json')) {
        try {
          if (hasLeaks(JSON.parse(text))) failures++;
        } catch {
          failures++;
        }
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
