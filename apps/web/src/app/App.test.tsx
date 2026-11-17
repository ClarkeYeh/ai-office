import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { App } from './App.js';

test('renders the placeholder page', () => {
  expect(renderToStaticMarkup(<App />)).toContain('<h1>AI Office</h1>');
});
