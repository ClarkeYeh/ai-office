// Stable entry points for tools delivered by subsequent M4 tasks.
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
/** @type {Record<string, [string, string, string[]]>} */
const tasks = {
  sprites: ['M4-T1', 'scripts/export-sprites/index.ts', []],
  'sprites:check': ['M4-T1', 'scripts/export-sprites/index.ts', ['--check']],
  'fixtures:web': ['M4-T7', 'scripts/record-web-fixtures/index.ts', []],
  'test:e2e': ['M4-T15', 'apps/e2e/package.json', []],
  'test:visual': ['M4-T15', 'apps/e2e/package.json', []],
  'e2e:fps': ['M4-T15', 'apps/e2e/package.json', []],
};
const name = process.argv[2] ?? '';
const task = tasks[/** @type {keyof typeof tasks} */ (name)];
if (!task) throw new Error(`Unknown M4 task: ${name}`);
const [owner, file, flags] = task;
try {
  await access(resolve(root, /** @type {string} */ (file)));
  const e2e = String(file).endsWith('package.json');
  const child = spawn(
    e2e ? 'pnpm' : process.execPath,
    e2e
      ? ['--dir', 'apps/e2e', 'run', name, ...process.argv.slice(3)]
      : [String(file), ...flags, ...process.argv.slice(3)],
    { cwd: root, stdio: 'inherit' },
  );
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch {
  console.error(`${name} is not available yet: ${owner} must provide ${file}.`);
  process.exitCode = 1;
}
