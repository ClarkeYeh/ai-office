import { expect, test, type Page } from '@playwright/test';
import type { GateView } from '@ai-office/contracts/api';
import {
  gates,
  readModel,
  startWorkflow,
  until,
  useOffice,
} from '../../test-support/index.js';
import { expectNoBlockingAxe, tabUntil } from './axe.js';

/**
 * M4-T16 accessibility (§2.3 I-08, M4_DESIGN §5.4): axe has no serious or
 * critical issue on every workflow screen and each stage gate kind; keyboard
 * paths through the office, the inspector and a gate; nothing animates under
 * reduced motion. Exception and question pages are checked in trouble.spec.ts.
 */
const office = useOffice({ scenario: 'mainline' });

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 1000 } });

let workflowId: string;
const path = () => `/workflows/${encodeURIComponent(workflowId)}`;
const openGate = async (stageKind: GateView['stageKind']) =>
  (
    await until(
      () => gates(office(), workflowId),
      (list) =>
        list.some((g) => g.stageKind === stageKind && g.status === 'open'),
      `${stageKind} gate`,
    )
  ).find((g) => g.stageKind === stageKind && g.status === 'open')!;

test.beforeAll(async () => {
  workflowId = await startWorkflow(office(), {
    requirement: 'Acceptance: accessibility',
  });
});

test('office, board and timeline have no serious or critical axe issues', async ({
  page,
}) => {
  await openGate('meeting');
  for (const suffix of ['', '/board', '/timeline']) {
    await office().login(page, path() + suffix);
    await expect(page.getByTestId('home-link')).toBeVisible();
    await expectNoBlockingAxe(page, path() + suffix);
  }
  // The replay view too (banner, read-only timeline controls).
  await page.getByTestId('timeline-open').click();
  await expect(page.getByTestId('timeline-scrubber')).toBeEnabled();
  await expectNoBlockingAxe(page, 'replay');
});

test('office keyboard at a gate: strip → room plates → scene objects → needs; amber focus; Enter zooms, Esc restores (I-08, D13)', async ({
  page,
}) => {
  await office().login(page, path());
  const scene = page.getByTestId('office-scene');
  await expect(scene).toBeVisible();
  // The meeting gate hushes the floor: no seats, so Tab reaches the plates,
  // whiteboard, inbox and your desk, then leaves for the right column.
  const reached: string[] = [];
  await tabUntil(page, reached, (id) => id.startsWith('need-'));
  const order = (prefix: string) =>
    reached.findIndex((id) => id.startsWith(prefix));
  const steps = [
    'stage-gate-',
    'room-',
    'office-whiteboard',
    'office-your-desk',
    'need-',
  ].map(order);
  expect(steps, reached.join(' → ')).toEqual([...steps].sort((a, b) => a - b));
  expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);

  const plate = scene.locator('[data-testid^="room-"]').first();
  await plate.focus();
  // 3 px amber focus ring (tokens.css --amber #feae34).
  await expect(plate).toHaveCSS('outline-width', '3px');
  await expect(plate).toHaveCSS('outline-color', 'rgb(254, 174, 52)');
  await page.keyboard.press('Enter');
  await expect(scene).toHaveAttribute('data-zoom', /.+/);
  await page.keyboard.press('Escape');
  await expect(scene).not.toHaveAttribute('data-zoom', /.+/);
  // Your desk (Enter) moves focus to the needs list.
  await page.getByTestId('office-your-desk').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('needs-panel')).toBeFocused();
});

async function keyboardApprove(page: Page, gate: GateView, testId: string) {
  await office().login(page, `/gates/${encodeURIComponent(gate.gateId)}`);
  await expect(page.getByTestId(`gate-page-${gate.gateId}`)).toBeVisible();
  await expectNoBlockingAxe(page, `${gate.stageKind} gate`);
  await expect(page.getByTestId(testId)).toBeEnabled();
  await tabUntil(page, [], (id) => id === testId);
  await page.keyboard.press('Enter');
  await until(
    async () =>
      (await readModel(office(), workflowId)).gates.find(
        (g) => g.gateId === gate.gateId,
      )?.status,
    (status) => status !== 'open',
    `${gate.stageKind} gate decided by keyboard`,
  );
}

test('phone width: no office, but needs and a gate decision work (I-21, D8)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const gate = await openGate('meeting');
  await office().login(page, path());
  await expect(page.getByTestId('office-scene')).toHaveCount(0);
  await expect(page.getByTestId('mobile-office-message')).toBeVisible();
  await page.getByTestId(`need-${gate.gateId}`).click();
  await expect(page.getByTestId(`gate-page-${gate.gateId}`)).toBeVisible();
  await expectNoBlockingAxe(page, 'meeting gate, phone width');
  // Nothing scrolls sideways at phone width.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByTestId('gate-approve').click();
  await until(
    async () =>
      (await readModel(office(), workflowId)).gates.find(
        (g) => g.gateId === gate.gateId,
      )?.status,
    (status) => status !== 'open',
    'meeting gate decided at phone width',
  );
});

test('gate page: quiet-office thumbnail at 1× and the stage strip states (V3Gate)', async ({
  page,
}) => {
  const gate = await openGate('planning');
  await office().login(page, `/gates/${encodeURIComponent(gate.gateId)}`);
  const slot = page.getByTestId('gate-thumbnail');
  await expect(slot).toHaveAttribute('role', 'img');
  const scene = slot.getByTestId('office-scene');
  await expect(scene).toHaveAttribute('data-scale', '1');
  await expect(scene).toHaveAttribute('data-still', 'true');
  await expect(scene).toHaveAttribute('aria-hidden', 'true');
  // Hushed office, your desk lit with "!", no buttons, no text labels at 1×.
  await expect(slot.getByTestId('office-hush')).toBeAttached();
  await expect(slot.getByTestId('office-your-desk-bang')).toBeVisible();
  await expect(slot.locator('button')).toHaveCount(0);
  await expect(slot.locator('[data-testid^="room-"]').first()).toBeHidden();
  // The scene fits the slot at 1× (no sideways overflow).
  const fits = await slot.evaluate((element) => {
    const sceneBox = element
      .querySelector('[data-testid="office-scene"]')!
      .getBoundingClientRect();
    return sceneBox.width <= element.getBoundingClientRect().width;
  });
  expect(fits).toBe(true);

  // Strip: ✓ meeting and its decided conclusion gate, the open task split,
  // flags on the gates still ahead; the final PR is one chip.
  await expect(page.getByTestId('stage-meeting')).toHaveAttribute(
    'data-status',
    'done',
  );
  await expect(page.getByTestId('stage-flag-conclusion')).toHaveAttribute(
    'data-state',
    'done',
  );
  await expect(page.getByTestId(`stage-gate-${gate.gateId}`)).toHaveAttribute(
    'data-state',
    'open',
  );
  await expect(page.getByTestId('stage-flag-final-pr')).toHaveAttribute(
    'data-state',
    'pending',
  );
  await expect(page.getByTestId('stage-final-pr')).toHaveCount(0);
});

test('stage gates: axe clean and approved with the keyboard alone (I-08, D6)', async ({
  page,
}) => {
  await keyboardApprove(page, await openGate('planning'), 'tasks-approve');
  const final = await openGate('final-pr');
  await office().login(page, `/gates/${encodeURIComponent(final.gateId)}`);
  await expect(page.getByTestId('final-pr-link')).toBeVisible();
  await expectNoBlockingAxe(page, 'final-pr gate');
});

test('reduced motion: nothing animates on the office or a gate (D4)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const target of [
    path(),
    `/gates/${encodeURIComponent((await openGate('final-pr')).gateId)}`,
  ]) {
    await office().login(page, target);
    await expect(page.getByTestId('home-link')).toBeVisible();
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === 'running').length,
    );
    expect(running, target).toBe(0);
  }
});
