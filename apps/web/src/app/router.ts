import { useSyncExternalStore } from 'react';

const routePatterns = [
  ['home', '/'],
  ['newWorkflow', '/workflows/new'],
  ['workflow', '/workflows/:id'],
  ['board', '/workflows/:id/board'],
  ['timeline', '/workflows/:id/timeline'],
  ['gate', '/gates/:id'],
  ['question', '/questions/:id'],
  ['templates', '/templates'],
  ['template', '/templates/:id'],
  ['repos', '/repos'],
] as const;
export type RouteName = (typeof routePatterns)[number][0] | 'notFound';
export interface RouteMatch {
  name: RouteName;
  params: Readonly<Record<string, string>>;
}
export function matchRoute(pathname: string): RouteMatch {
  const parts = pathname.replace(/\/$/, '').split('/');
  for (const [name, pattern] of routePatterns) {
    const expected = pattern.replace(/\/$/, '').split('/');
    if (parts.length !== expected.length) continue;
    const params: Record<string, string> = {};
    const matches = expected.every((part, index) => {
      if (!part.startsWith(':')) return parts[index] === part;
      try {
        const value = decodeURIComponent(parts[index]!);
        if (!value) return false;
        params[part.slice(1)] = value;
        return true;
      } catch {
        return false;
      }
    });
    if (matches) return { name, params };
  }
  return { name: 'notFound', params: {} };
}
export function navigate(
  href: string,
  options: { replace?: boolean } = {},
): void {
  const url = new URL(href, globalThis.location.href);
  if (url.origin !== globalThis.location.origin)
    throw new Error('Only same-origin navigation is supported');
  globalThis.history[options.replace ? 'replaceState' : 'pushState'](
    null,
    '',
    url.pathname + url.search + url.hash,
  );
  globalThis.dispatchEvent(new PopStateEvent('popstate'));
}
function subscribe(listener: () => void) {
  globalThis.addEventListener('popstate', listener);
  return () => globalThis.removeEventListener('popstate', listener);
}
export function useRoute(): RouteMatch {
  const path = useSyncExternalStore(
    subscribe,
    () => globalThis.location.pathname,
    () => '/',
  );
  return matchRoute(path);
}
