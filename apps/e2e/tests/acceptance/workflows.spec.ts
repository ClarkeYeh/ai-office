import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  finalPrNumber,
  gates,
  isEnded,
  readModel,
  startWorkflow,
  until,
  useOffice,
} from '../../test-support/index.js';

/**
 * M4-T16 acceptance, §2.3 I-17–I-19 (M4-T12 flows) on the built backend:
 * template diagnostics and preselection, repo registration, a UI start with
 * both optional gates off, slot busy, an explicit final merge, cancel and
 * clean-up. `mainline` runs the built-in `feature-to-pr` template quickly.
 */
const office = useOffice({ scenario: 'mainline' });

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

test('template diagnostics list a broken file; "use this template" preselects it (I-18)', async ({
  page,
}) => {
  const broken = join(office().home, 'templates', 'broken.yaml');
  await writeFile(broken, 'apiVersion: ai-office/v1alpha1\nid: broken\n');
  try {
    await office().login(page, '/templates');
    const errors = page.getByTestId('template-errors');
    await expect(errors).toBeVisible();
    await expect(errors).toContainText('broken.yaml');

    await page.getByTestId('template-feature-to-pr').click();
    await expect(page).toHaveURL(/\/templates\/feature-to-pr$/);
    await expect(page.getByTestId('template-gate-conclusion')).toBeVisible();
    await expect(page.getByTestId('template-gate-final-pr')).toBeVisible();

    await page.getByTestId('template-feature-to-pr').click();
    await expect(page).toHaveURL(/\/workflows\/new\?template=feature-to-pr$/);
    await expect(page.getByTestId('workflow-template')).toHaveValue(
      'feature-to-pr',
    );
    // The start form repeats the diagnostics so a broken file is not silent.
    await expect(page.getByTestId('template-errors')).toContainText(
      'broken.yaml',
    );
  } finally {
    await rm(broken, { force: true });
  }
});

test('repo registration shows the checks and refuses an unknown path (I-19)', async ({
  page,
}) => {
  await office().login(page, '/repos');
  const repos = await office().api<{ repos: Array<{ repoId: string }> }>(
    'GET',
    '/api/v1/repos',
  );
  const repoId = repos.body.repos[0]!.repoId;
  await expect(page.getByTestId(`repo-check-${repoId}`)).toBeVisible();

  await page.getByTestId('repo-path').fill('/fake/repos/demo');
  await page.getByTestId('repo-register').click();
  const result = page.getByTestId('repo-result');
  await expect(result).toHaveAttribute('role', 'status');
  await expect(page.getByTestId(`repo-check-${repoId}`)).toBeVisible();

  await page.getByTestId(`repo-check-${repoId}`).click();
  await expect(result).toHaveAttribute('role', 'status');

  await page.getByTestId('repo-path').fill('/fake/repos/not-registered');
  await page.getByTestId('repo-register').click();
  await expect(result).toHaveAttribute('role', 'alert');
  expect(
    (await office().api<{ repos: unknown[] }>('GET', '/api/v1/repos')).body
      .repos,
  ).toHaveLength(1);
});

test('UI start with optional gates off, slot busy, explicit final merge, clean-up (I-17, I-14)', async ({
  page,
}) => {
  await office().login(page, '/workflows/new');
  await page.getByTestId('workflow-requirement').fill('Acceptance: gates off');
  await expect(page.getByTestId('workflow-template')).toHaveValue(
    'feature-to-pr',
  );
  await page.getByTestId('gate-toggle-conclusion').uncheck();
  await page.getByTestId('gate-toggle-task-split').uncheck();
  await expect(page.getByTestId('gate-toggle-final-pr')).toBeDisabled();
  await expect(page.getByTestId('gate-toggle-final-pr')).toBeChecked();
  await page.getByTestId('workflow-start').click();
  await expect(page).toHaveURL(/\/workflows\/(?!new$)[^/?]+$/);
  const workflowId = decodeURIComponent(
    new URL(page.url()).pathname.split('/').at(-1)!,
  );
  await expect(page.getByTestId('office-scene')).toBeVisible();

  // Slot busy: the form explains and disables start; the server agrees.
  await page.goto(office().url + '/workflows/new');
  await expect(page.getByTestId('workflow-slot-busy')).toBeVisible();
  await page.getByTestId('workflow-requirement').fill('Second');
  await expect(page.getByTestId('workflow-start')).toBeDisabled();
  const repos = await office().api<{ repos: Array<{ repoId: string }> }>(
    'GET',
    '/api/v1/repos',
  );
  const busy = await office().api<{ error: { code: string } }>(
    'POST',
    '/api/v1/workflows',
    {
      templateId: 'feature-to-pr',
      repoId: repos.body.repos[0]!.repoId,
      requirement: 'Second',
    },
  );
  expect(busy.status).toBe(409);
  expect(JSON.stringify(busy.body)).toContain('workflow_slot_busy');

  // Both optional gates were off: the first gate is the final PR.
  const number = await until(
    () => finalPrNumber(office(), workflowId),
    (value) => value !== undefined,
    'final PR gate',
    45_000,
  );
  const opened = await gates(office(), workflowId);
  expect(opened.map((gate) => gate.stageKind)).toEqual(['final-pr']);
  const finalGate = opened[0]!;

  await page.goto(office().url + `/workflows/${workflowId}`);
  await page.getByTestId(`stage-gate-${finalGate.gateId}`).click();
  await expect(page).toHaveURL(/\/gates\//);
  await expect(page.getByTestId('final-pr-link')).toBeVisible();
  await expect(page.getByTestId('final-feedback')).toBeEnabled();

  // S14: nothing merges the final PR on a timer.
  await delay(1500);
  expect((await readModel(office(), workflowId)).status).toBe('running');
  await office().fake.mergeFinalPr(number!);
  const ended = await until(
    () => readModel(office(), workflowId),
    isEnded,
    'workflow end after the explicit final merge',
  );
  expect(ended.status).toBe('completed');

  await page.goto(office().url + `/workflows/${workflowId}`);
  await expect(page.getByTestId('office-door')).toHaveAttribute(
    'data-open',
    'true',
  );

  await page.getByTestId('home-link').click();
  await page.getByTestId(`workflow-cleanup-${workflowId}`).click();
  await page.getByTestId('workflow-confirm').click();
  await expect(page.getByRole('status').first()).toBeVisible();
  await expect(page.getByTestId('workflow-confirm')).toHaveCount(0);
});

test('a running workflow is cancelled from the list (I-17)', async ({
  page,
}) => {
  const workflowId = await startWorkflow(office(), {
    requirement: 'Acceptance: cancel me',
  });
  await office().login(page, '/');
  await page.getByTestId(`workflow-cancel-${workflowId}`).click();
  await page.getByTestId('workflow-confirm').click();
  const ended = await until(
    () => readModel(office(), workflowId),
    isEnded,
    'cancelled workflow',
  );
  expect(ended.status).toBe('cancelled');
  await expect(page.getByTestId(`workflow-cancel-${workflowId}`)).toHaveCount(
    0,
  );
});

test('an expired session sends the app back to the sign-in explanation (I-01)', async ({
  page,
  context,
}) => {
  await office().login(page, '/');
  await expect(page.getByTestId('home-link')).toBeVisible();
  await context.clearCookies();
  // The next API call (client-side navigation) answers 401.
  await page.getByTestId('nav-templates').click();
  await expect(page.getByTestId('auth-required')).toBeVisible();
});
