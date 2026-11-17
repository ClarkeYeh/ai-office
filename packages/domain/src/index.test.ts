import { expect, test } from 'vitest';
import * as publicApi from './index.js';

test('domain exposes a module', () => {
  expect(publicApi).toBeDefined();
});
