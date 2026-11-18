import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Link, NavigationContext } from '../shared/ui/index.js';
import { matchRoute, navigate, useRoute } from './router.js';
afterEach(cleanup);
test.each([
  ['/', 'home'],
  ['/workflows/new', 'newWorkflow'],
  ['/workflows/w', 'workflow'],
  ['/workflows/w/board', 'board'],
  ['/workflows/w/timeline', 'timeline'],
  ['/gates/g', 'gate'],
  ['/questions/q', 'question'],
  ['/templates', 'templates'],
  ['/templates/t', 'template'],
  ['/repos', 'repos'],
  ['/elsewhere', 'notFound'],
  ['/workflows/%ZZ', 'notFound'],
  ['/workflows/', 'notFound'],
])('matches %s', (path, name) => {
  expect(matchRoute(path).name).toBe(name);
});
test('decodes ids and accepts a trailing slash', () => {
  expect(matchRoute('/gates/a%2Fb/')).toEqual({
    name: 'gate',
    params: { id: 'a/b' },
  });
});
test('history, popstate and links update without full navigation', () => {
  globalThis.history.replaceState(null, '', '/');
  function Probe() {
    const route = useRoute();
    return <span data-testid="route">{route.name}</span>;
  }
  render(
    <NavigationContext.Provider value={{ navigate }}>
      <Probe />
      <Link href="/gates/g" aria-label="gate" data-testid="go">
        gate
      </Link>
    </NavigationContext.Provider>,
  );
  fireEvent.click(screen.getByTestId('go'), { ctrlKey: true });
  expect(screen.getByTestId('route').textContent).toBe('home');
  fireEvent.click(screen.getByTestId('go'));
  expect(screen.getByTestId('route').textContent).toBe('gate');
  act(() => navigate('/repos?sort=name', { replace: true }));
  expect(screen.getByTestId('route').textContent).toBe('repos');
  act(() => {
    globalThis.history.replaceState(null, '', '/');
    globalThis.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(screen.getByTestId('route').textContent).toBe('home');
  expect(() => navigate('https://example.org')).toThrow('same-origin');
});
