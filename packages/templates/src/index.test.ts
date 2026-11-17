import { expect, test } from 'vitest';
import * as publicApi from './index.js';

test('templates exposes a module', () => {
  expect(publicApi).toBeDefined();
});
