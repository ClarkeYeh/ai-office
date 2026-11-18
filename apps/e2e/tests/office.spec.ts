import { expect, test, type Page } from '@playwright/test';
import { startWorkflow, useOffice } from '../test-support/index.js';

const office = useOffice({ scenario: 'trouble' });
let workflowId: string;
test.beforeAll(async () => {
  workflowId = await startWorkflow(office(), { templateId: 'trouble' });
});
test.use({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const openWorkflow = (page: Page) =>
  office().login(page, `/workflows/${encodeURIComponent(workflowId)}`);

test('office keyboard selection, whiteboard, board and usage', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openWorkflow(page);
  const scene = page.getByTestId('office-scene');
  await expect(scene).toBeVisible();
  expect(Number(await scene.getAttribute('data-scale'))).toBe(3);
  const seat = scene.locator('button[data-pose]').first();
  await seat.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/seat=/);
  await expect(page.getByTestId('seat-inspector')).toBeVisible();
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
  await openWorkflow(page);
  await expect(page.getByTestId('needs-panel')).toBeVisible();
  await expect(page.getByTestId('mobile-office-message')).toBeVisible();
  await expect(page.getByTestId('office-scene')).toHaveCount(0);
  await expect(page.getByTestId('office-inspector-slot')).toHaveCount(0);
});
