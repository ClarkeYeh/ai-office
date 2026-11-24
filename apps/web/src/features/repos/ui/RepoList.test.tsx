import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { repo } from '../../workflows/test-support/setup.js';
import { t, tCode } from '../../../shared/lib/i18n/index.js';
import { RepoList } from './RepoList.js';

afterEach(cleanup);
test('renders repo warnings as accessible text and hides absent or empty warnings', () => {
  const props = {
    pending: false,
    loading: false,
    message: null,
    error: false,
    onRegister: vi.fn(),
    onRefresh: vi.fn(),
    onDetail: vi.fn(),
  };
  const warnings = [
    'default_unprotected',
    'merge_commit_disabled',
    'toString',
    '<script>',
  ];
  const { container, rerender } = render(
    <RepoList {...props} repos={[{ ...repo, warnings }]} />,
  );
  expect(screen.getByLabelText(t('repos.warnings'))).toBeTruthy();
  for (const warning of warnings)
    expect(screen.getByTestId('repo-warnings-r1').textContent).toContain(
      tCode('repoWarning', warning),
    );
  expect(container.querySelector('script')).toBeNull();
  rerender(<RepoList {...props} repos={[{ ...repo, warnings: [] }]} />);
  expect(screen.queryByTestId('repo-warnings-r1')).toBeNull();
  rerender(<RepoList {...props} repos={[repo]} />);
  expect(screen.queryByTestId('repo-warnings-r1')).toBeNull();
});
