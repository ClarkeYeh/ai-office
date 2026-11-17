import { expect, test } from 'vitest';
import * as publicApi from './index.js';

test('contracts exposes a module', () => {
  expect(publicApi).toBeDefined();
});
