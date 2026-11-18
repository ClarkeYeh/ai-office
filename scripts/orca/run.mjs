import { pathToFileURL } from 'node:url';
import { runHarnessCli } from '../../apps/server/dist/test-support/orca/runner.js';
export { runHarnessCli };
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runHarnessCli(process.argv.slice(2));
  } catch {
    // Never echo command output, args, or parser exceptions (may contain private text).
    console.error(
      'Orca harness refused or failed; inspect the private resource ledger and harness README.',
    );
    process.exitCode = 1;
  }
}
