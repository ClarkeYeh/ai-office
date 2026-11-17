import { expect, test } from 'vitest';
import * as publicApi from './index.js';

test('engine exposes a module', () => {
  expect(publicApi).toBeDefined();
});
