import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { useOffice } from '../test-support/index.js';

/**
 * v0.1.1 repo picker in fake mode: the fake world's Orca repos and GitHub
 * repos are listed, one is registered from the list and shows ✓.
 */
const office = useOffice({ scenario: 'demo' });

test.use({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });

test('lists Orca and GitHub repos and registers one from the list', async ({
  page,
}) => {
  await office().login(page, '/repos');
  const local = page.getByTestId('repo-candidates-local');
  await expect(local.getByRole('listitem')).toHaveCount(3);
  // The fake repo registered at startup, a registrable one, one without origin.
  await expect(page.getByTestId('local-candidate-registered-0')).toBeVisible();
  await expect(page.getByTestId('local-candidate-problem-2')).toBeVisible();
  await expect(page.getByTestId('local-candidate-register-2')).toBeDisabled();

  const remote = page.getByTestId('repo-candidates-remote');
  await expect(remote.getByRole('heading', { level: 2 })).toContainText(
    'ai-office-fake',
  );
  await expect(remote.getByRole('listitem')).toHaveCount(4);
  await expect(
    remote.getByText('git clone https://github.com/ai-office-fake/website'),
  ).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => v.id),
  ).toEqual([]);

  await page.getByTestId('local-candidate-register-1').click();
  await expect(page.getByTestId('local-candidate-registered-1')).toBeVisible();
  await expect(page.getByTestId('repo-result')).toHaveAttribute(
    'role',
    'status',
  );
  const repos = await office().api<{
    repos: Array<{ localPath: string; github: { name: string } }>;
  }>('GET', '/api/v1/repos');
  expect(repos.body.repos.map((repo) => repo.localPath)).toEqual([
    '/fake/repos/demo',
    '/fake/repos/tools',
  ]);
  // The GitHub row of the newly registered repo links to its local row.
  const link = remote.getByRole('link', { name: /tools/ });
  await expect(link).toHaveAttribute('href', '#local-candidate-1');
});

test('stays usable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await office().login(page, '/repos');
  await expect(
    page.getByTestId('repo-candidates-local').getByRole('listitem'),
  ).toHaveCount(3);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByTestId('repo-path')).toBeVisible();
});
