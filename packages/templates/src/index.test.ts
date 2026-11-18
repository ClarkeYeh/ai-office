import { expect, test } from 'vitest';
import { builtinTemplateUrls } from './index.js';
test('exports built-in template locations', () => {
  expect(
    builtinTemplateUrls.map((url) => url.pathname.split('/').pop()),
  ).toEqual(['feature-to-pr.yaml']);
});
