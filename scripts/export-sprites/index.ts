// pnpm sprites            regenerate assets/ (PNGs only rewritten when their pixels change)
// pnpm sprites:check      fail when assets/ is stale or the output breaks a rule (M4_PLAN §4.4)
// pnpm sprites --sheet D  also write D/sprites-sheet.html for review
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import {
  checkGenerated,
  compareCommitted,
  encodeAssets,
  writeAssets,
} from './assets.ts';
import { sheetHtml } from './sheet.ts';

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    sheet: { type: 'string' },
  },
});

const assets = encodeAssets();
const problems = checkGenerated(assets, encodeAssets());
if (values.check) problems.push(...(await compareCommitted(assets)));
else if (problems.length === 0) {
  const written = await writeAssets(assets);
  console.log(
    written.length
      ? `Wrote ${written.join(', ')}`
      : 'Sprite assets are up to date.',
  );
}
if (values.sheet) {
  await mkdir(values.sheet, { recursive: true });
  const file = join(values.sheet, 'sprites-sheet.html');
  await writeFile(file, sheetHtml(assets));
  console.log(`Wrote ${file}`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else if (values.check) console.log('Sprite assets match the sprite source.');
