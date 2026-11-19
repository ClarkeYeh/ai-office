import { expect, test } from '@playwright/test';
import type { GateView } from '@ai-office/contracts/api';
import {
  gates,
  readModel,
  startWorkflow,
  until,
  useOffice,
} from '../test-support/index.js';

/**
 * M4_PLAN §5.4: the hijack e2e deferred to convergence. M2's runtime-fake
 * stimulus (`/dev/fake/runtime/hijack`) hands the run to another coordinator;
 * the office shows the takeover and the hijack gate reclaims it through the UI.
 */
const office = useOffice({ scenario: 'mainline' });

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

const openHijackGate = (list: GateView[]) =>
  list.find(
    (gate) => gate.status === 'open' && gate.exceptionKind === 'hijacked',
  );

test('a run takeover pauses the workflow and is reclaimed through the hijack gate', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workflowId = await startWorkflow(office(), {
    requirement: 'Acceptance: hijack',
  });
  await until(
    () => readModel(office(), workflowId),
    (model) => model.status === 'running',
    'workflow running',
  );
  await office().login(page, `/workflows/${encodeURIComponent(workflowId)}`);
  await expect(page.getByTestId('office-scene')).toBeVisible();
  await expect(page.getByTestId('banner-hijacked')).toHaveCount(0);
  expect((await office().fake.hijack()).hijacked).toBeGreaterThan(0);
  const gate = openHijackGate(
    await until(
      () => gates(office(), workflowId),
      (list) => openHijackGate(list) !== undefined,
      'hijack gate',
    ),
  )!;

  expect((await readModel(office(), workflowId)).pausedReasons).not.toEqual([]);
  await expect(page.getByTestId('banner-hijacked')).toBeVisible();
  await expect(page.locator('[data-testid^="pause-"]').first()).toBeVisible();

  await office().login(page, `/gates/${encodeURIComponent(gate.gateId)}`);
  await expect(page.getByTestId(`gate-page-${gate.gateId}`)).toBeVisible();
  await page.getByTestId('option-reclaim').check();
  await page.getByTestId('option-submit').click();
  await until(
    () => gates(office(), workflowId),
    (list) =>
      list.find((entry) => entry.gateId === gate.gateId)?.status !== 'open',
    'hijack gate decided',
  );
  await until(
    () => readModel(office(), workflowId),
    (model) => model.pausedReasons.length === 0,
    'workflow resumed',
  );
  // `runOwned` recovers on the next runtime health refresh, not on the reclaim
  // itself, so only the pause is asserted to clear here.
  await expect(page.locator('[data-testid^="pause-"]')).toHaveCount(0);
});
