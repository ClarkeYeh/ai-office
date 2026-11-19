import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { setup, repo } from '../../workflows/test-support/setup.js';
import { ApiError } from '../../../api/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { ReposPage } from './ReposPage.js';
afterEach(cleanup);
test('registration sends only the local path and renders returned checks', async () => {
  const { api } = setup();
  api.listRepos.mockResolvedValue({ repos: [] });
  render(<ReposPage api={api} />);
  await screen.findByText(t('repos.empty'));
  const user = userEvent.setup();
  await user.type(screen.getByTestId('repo-path'), '/projects/demo');
  await user.click(screen.getByTestId('repo-register'));
  expect(api.registerRepo).toHaveBeenCalledWith({
    localPath: '/projects/demo',
  });
  expect(await screen.findByText('octo/demo')).toBeTruthy();
  expect(screen.getByText(t('repos.unknown'))).toBeTruthy();
  api.getRepo.mockResolvedValueOnce({
    ...repo,
    status: 'invalid',
    issues: ['Missing protection'],
    defaultBranchProtected: false,
  });
  await user.click(screen.getByTestId('repo-check-r1'));
  expect(await screen.findByText('Missing protection')).toBeTruthy();
});
test('registration failure explains the check and preserves the path', async () => {
  const { api } = setup();
  api.registerRepo.mockRejectedValueOnce(
    new ApiError(422, {
      code: 'repo_not_in_orca',
      category: 'validation',
      retryable: false,
      message: 'diagnostic',
    }),
  );
  render(<ReposPage api={api} />);
  await screen.findByText('octo/demo');
  const user = userEvent.setup();
  await user.type(screen.getByTestId('repo-path'), '/projects/demo');
  await user.click(screen.getByTestId('repo-register'));
  expect((await screen.findByTestId('repo-result')).textContent).toBe(
    t('repos.repo_not_in_orca'),
  );
  expect((screen.getByTestId('repo-path') as HTMLInputElement).value).toBe(
    '/projects/demo',
  );
});
