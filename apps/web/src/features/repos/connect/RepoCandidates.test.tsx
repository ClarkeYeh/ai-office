import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { RepoCandidatesResponse } from '@ai-office/contracts/api';
import { setup } from '../../workflows/test-support/setup.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { ReposPage } from './ReposPage.js';
afterEach(cleanup);

const candidates = (registered = false): RepoCandidatesResponse => ({
  local: [
    {
      path: '/Users/example/workspace/demo',
      displayName: 'demo',
      github: { owner: 'octo', name: 'demo' },
      registered: true,
    },
    {
      path: '/Users/example/workspace/tools',
      displayName: 'tools',
      github: { owner: 'octo', name: 'tools' },
      registered,
    },
    {
      path: '/Users/example/workspace/notes',
      displayName: 'notes',
      github: null,
      registered: false,
      problem: 'invalid_github_origin',
    },
  ],
  remote: [
    {
      owner: 'octo',
      name: 'tools',
      visibility: 'public',
      archived: false,
      pushedAt: null,
      local: { path: '/Users/example/workspace/tools' },
      registered,
    },
    {
      owner: 'octo',
      name: 'site',
      visibility: 'private',
      archived: false,
      pushedAt: null,
      local: null,
      registered: false,
    },
    {
      owner: 'octo',
      name: 'legacy',
      visibility: 'public',
      archived: true,
      pushedAt: null,
      local: null,
      registered: false,
    },
  ],
  sources: { orca: 'ok', github: 'ok' },
});

test('lists Orca and GitHub repos; registers from the list and shows ✓', async () => {
  const { api } = setup();
  api.listRepoCandidates
    .mockResolvedValueOnce(candidates())
    .mockResolvedValueOnce(candidates(true));
  render(<ReposPage api={api} />);
  const local = await screen.findByTestId('repo-candidates-local');
  expect(within(local).getByText(t('repos.localTitle'))).toBeTruthy();
  expect(within(local).getByText('…/workspace/tools')).toBeTruthy();
  expect(screen.getByTestId('local-candidate-registered-0').textContent).toBe(
    t('repos.candidateRegistered'),
  );
  // No GitHub origin: the reason is shown and the row cannot be registered.
  expect(screen.getByTestId('local-candidate-problem-2').textContent).toBe(
    t('repos.problem.invalid_github_origin'),
  );
  expect(
    (screen.getByTestId('local-candidate-register-2') as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  const user = userEvent.setup();
  await user.click(screen.getByTestId('local-candidate-register-1'));
  expect(api.registerRepo).toHaveBeenCalledWith({
    localPath: '/Users/example/workspace/tools',
  });
  expect(
    (await screen.findByTestId('local-candidate-registered-1')).textContent,
  ).toBe(t('repos.candidateRegistered'));
  expect(api.listRepoCandidates).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('repo-result').textContent).toBe(
    t('repos.success'),
  );
  // The manual field stays as the fallback.
  expect(screen.getByText(t('repos.manualTitle'))).toBeTruthy();
  expect(screen.getByTestId('repo-path')).toBeTruthy();
});

test('GitHub rows link to their local row or show a copyable clone hint', async () => {
  const { api } = setup();
  api.listRepoCandidates.mockResolvedValue(candidates());
  const copy = vi.fn(async () => {});
  render(<ReposPage api={api} copy={copy} />);
  const remote = await screen.findByTestId('repo-candidates-remote');
  expect(
    within(remote).getByText(t('repos.remoteTitle', { login: 'octo' })),
  ).toBeTruthy();
  const link = screen.getByTestId('remote-candidate-local-0');
  expect(link.getAttribute('href')).toBe('#local-candidate-1');
  expect(document.getElementById('local-candidate-1')).toBeTruthy();
  const hint = screen.getByTestId('remote-candidate-hint-1').textContent;
  expect(hint).toBe(
    'git clone https://github.com/octo/site ~/site\norca repo add --path ~/site',
  );
  expect(
    within(screen.getByTestId('remote-candidate-1')).getByText(
      t('repos.notInOrca'),
    ),
  ).toBeTruthy();
  // Archived repos are marked (and dimmed by style).
  expect(
    within(screen.getByTestId('remote-candidate-2')).getByText(
      `${t('repos.public')} · ${t('repos.archived')}`,
    ),
  ).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByTestId('remote-candidate-copy-1'));
  expect(copy).toHaveBeenCalledWith(hint);
  expect(
    (await screen.findByTestId('remote-candidate-copy-1')).textContent,
  ).toBe(t('repos.copied'));
  // Nothing was registered or run.
  expect(api.registerRepo).not.toHaveBeenCalled();
});

test('a failed source is explained while the other still lists; refresh refetches', async () => {
  const { api } = setup();
  api.listRepoCandidates.mockResolvedValueOnce({
    ...candidates(),
    remote: [],
    sources: { orca: 'ok', github: 'unavailable' },
  });
  api.listRepoCandidates.mockRejectedValueOnce(new Error('offline'));
  render(<ReposPage api={api} />);
  expect(
    (await screen.findByTestId('repo-candidates-github-unavailable'))
      .textContent,
  ).toBe(t('repos.githubUnavailable'));
  expect(screen.getByText(t('repos.remoteTitleNoLogin'))).toBeTruthy();
  expect(screen.getByTestId('local-candidate-register-1')).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByTestId('repo-candidates-refresh'));
  expect(
    (await screen.findByTestId('repo-candidates-failed')).textContent,
  ).toBe(t('repos.candidatesFailed'));
  expect(api.listRepoCandidates).toHaveBeenCalledTimes(2);
});
