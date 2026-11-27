import { expect, test } from 'vitest';
import {
  cloneCommands,
  localIndex,
  shortPath,
  viewerLogin,
} from './candidates.js';

test('shortens paths to their last two segments', () => {
  expect(shortPath('/Users/example/workspace/app')).toBe('…/workspace/app');
  expect(shortPath('/fake/repos/demo')).toBe('…/repos/demo');
  expect(shortPath('/repos/demo')).toBe('/repos/demo');
  expect(shortPath('/demo/')).toBe('/demo/');
});
test('builds the clone-then-add hint for a repo', () => {
  expect(cloneCommands({ owner: 'octo', name: 'site' })).toBe(
    'git clone https://github.com/octo/site ~/site\norca repo add --path ~/site',
  );
});
test('derives the viewer login and the linked local row', () => {
  const remote = {
    owner: 'octo',
    name: 'app',
    visibility: 'public' as const,
    archived: false,
    pushedAt: null,
    local: { path: '/b' },
    registered: false,
  };
  expect(viewerLogin([])).toBeNull();
  expect(viewerLogin([remote])).toBe('octo');
  const local = (path: string) => ({
    path,
    displayName: path,
    github: null,
    registered: false,
  });
  expect(localIndex([local('/a'), local('/b')], remote)).toBe(1);
  expect(localIndex([local('/a')], { ...remote, local: null })).toBe(-1);
});
