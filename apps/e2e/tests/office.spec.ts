import { expect, test } from '@playwright/test';

// T15 can supply its fake-backend fixture here. Until that workspace lands,
// run against an isolated dev:office --fake parallel/trouble instance using
// OFFICE_TEST_URL (the workflow URL) and OFFICE_STORAGE_STATE (authenticated state).
const workflowUrl = process.env['OFFICE_TEST_URL'];
test.use({
  ...(process.env['OFFICE_STORAGE_STATE']
    ? { storageState: process.env['OFFICE_STORAGE_STATE'] }
    : {}),
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
test.skip(
  !workflowUrl,
  'Requires an isolated fake workflow and authenticated session',
);

test('office keyboard selection, whiteboard, board and usage', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(workflowUrl!);
  const scene = page.getByTestId('office-scene');
  await expect(scene).toBeVisible();
  expect(Number(await scene.getAttribute('data-scale'))).toBe(3);
  const seat = scene.locator('button[data-pose]').first();
  await seat.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/seat=/);
  await expect(page.getByTestId('office-seat-summary')).toBeVisible();
  const selection = new URL(page.url()).search;
  await page.getByTestId('office-whiteboard').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('office-board')).toBeVisible();
  expect(new URL(page.url()).search).toBe(selection);
  await expect(page.getByTestId('board-column-queued')).toBeVisible();
  await page.getByTestId('view-office').click();
  await expect(scene).toBeVisible();
  expect(new URL(page.url()).search).toBe(selection);
  await page.getByTestId('office-your-desk').click();
  await expect(page.getByTestId('needs-panel')).toBeFocused();
  await expect(page.getByTestId('usage-paper-stack')).toBeAttached();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByTestId('office-legend')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile keeps needs but never mounts the office or inspector', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(workflowUrl!);
  await expect(page.getByTestId('needs-panel')).toBeVisible();
  await expect(page.getByTestId('mobile-office-message')).toBeVisible();
  await expect(page.getByTestId('office-scene')).toHaveCount(0);
  await expect(page.getByTestId('office-inspector-slot')).toHaveCount(0);
});
