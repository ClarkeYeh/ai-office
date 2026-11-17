import { expect, test } from 'vitest';
import * as publicApi from './index.js';

test('projection exposes a module', () => {
  expect(publicApi).toBeDefined();
});
