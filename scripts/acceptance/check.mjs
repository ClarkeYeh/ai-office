import { readFileSync } from 'node:fs';

// pnpm acceptance:check <events.json> [--github-facts <json>] [--json]
// Offline: reads an event export (raw array or the fixtures/m5 envelope) and an
// optional GitHub facts snapshot, prints a ✅/❌/N/A verdict per SPEC §24 row
// (M5_PLAN §9.1). Exit 1 when any row is ❌, 2 on usage or input errors.

const usage =
  'Usage: pnpm acceptance:check <events.json> [--github-facts <json>] [--json]';
const args = process.argv.slice(2);
let eventsPath;
let factsPath;
let json = false;
let bad = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--github-facts' && args[i + 1] !== undefined)
    factsPath = args[++i];
  else if (args[i] === '--json') json = true;
  else if (eventsPath === undefined && !args[i]?.startsWith('--'))
    eventsPath = args[i];
  else bad = true;
}

if (bad || eventsPath === undefined) {
  console.error(usage);
  process.exitCode = 2;
} else {
  let checker;
  try {
    checker =
      await import('../../apps/server/dist/test-support/acceptance-check/index.js');
  } catch {
    console.error('Build the server first: pnpm -r build');
    process.exitCode = 2;
  }
  if (checker !== undefined) {
    try {
      const read = (/** @type {string} */ path) =>
        JSON.parse(readFileSync(path, 'utf8'));
      const events = checker.eventsOf(read(eventsPath));
      const facts =
        factsPath === undefined ? {} : checker.parseFacts(read(factsPath));
      const report = checker.checkAcceptance(events, facts);
      console.log(
        json ? JSON.stringify(report, null, 2) : checker.formatReport(report),
      );
      process.exitCode = report.summary.fail > 0 ? 1 : 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
