import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions } from './index.mjs';

test('dev launcher only admits the implemented fake scenario', () => {
  assert.deepEqual(parseOptions([]), { fake: 'mainline', open: false });
  assert.deepEqual(parseOptions(['--fake', 'mainline', '--open']), {
    fake: 'mainline',
    open: true,
  });
  for (const args of [
    ['--fake'],
    ['--fake', '../production'],
    ['--port', '4319'],
    ['--home', '/tmp'],
  ])
    assert.throws(() => parseOptions(args));
});
