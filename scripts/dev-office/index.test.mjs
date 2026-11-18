import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions } from './index.mjs';

test('dev launcher only admits the implemented fake scenario', () => {
  assert.deepEqual(parseOptions([]), {
    fake: 'demo',
    open: false,
    autoMergeFinalSeconds: 8,
  });
  assert.deepEqual(parseOptions(['--fake', 'mainline', '--open']), {
    fake: 'mainline',
    open: true,
    autoMergeFinalSeconds: 0,
  });
  for (const args of [
    ['--fake'],
    ['--auto-merge-final', '-1'],
    ['--auto-merge-final'],
    ['--fake', '../production'],
    ['--port', '4319'],
    ['--home', '/tmp'],
  ])
    assert.throws(() => parseOptions(args));
});
