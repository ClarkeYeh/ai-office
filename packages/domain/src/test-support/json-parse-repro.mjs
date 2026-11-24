// Run with plain Node; this imports no project code or dependencies.
import { log } from 'node:console';
import process from 'node:process';

log('Node', process.versions.node, 'V8', process.versions.v8);
for (const key of ['"', '\\', '"']) {
  const source = JSON.stringify({ scope: 'stage', [key]: false });
  const actual = Object.keys(JSON.parse(source))[1];
  log(JSON.stringify({ source, expected: key, actual, ok: actual === key }));
}
