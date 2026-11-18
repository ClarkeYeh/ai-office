import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fixtureRedactor } from './redaction.ts';

try {
  if (process.argv.length > 3) throw new Error('Invalid arguments');
  const input = readFileSync(process.argv[2] ?? 0, 'utf8');
  process.stdout.write(
    JSON.stringify(
      fixtureRedactor(process.argv[2]).sanitize(JSON.parse(input)),
      null,
      2,
    ) + '\n',
  );
} catch {
  process.stderr.write(
    'Fixture sanitization failed (expected JSON on stdin or one file argument).\n',
  );
  process.exitCode = 1;
}
