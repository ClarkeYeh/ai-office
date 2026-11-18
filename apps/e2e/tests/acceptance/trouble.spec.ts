import { expect, test, type Page } from '@playwright/test';
import type { GateView } from '@ai-office/contracts/api';
import {
  gates,
  readModel,
  startWorkflow,
  until,
  useOffice,
} from '../../test-support/index.js';
import { expectNoBlockingAxe } from './axe.js';

/**
 * M4-T16 acceptance on the `trouble` scenario (§2.3 I-04, I-15, I-16): the
 * runtime pause banner, exception gates decided through the UI (plain option,
 * an option with an `agent` input, rework), and an escalated question answered
 * on its page. Stage gates and repeated exceptions are decided over HTTP to
 * keep the run short; each kind is driven through the UI once.
 */
const office = useOffice({ scenario: 'trouble' });

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

let workflowId: string;
test.beforeAll(async () => {
  workflowId = await startWorkflow(office(), {
    templateId: 'trouble',
    requirement: 'Acceptance: trouble',
  });
});

const officePath = () => `/workflows/${encodeURIComponent(workflowId)}`;
const detail = async (gateId: string) =>
  (
    await office().api<GateView>(
      'GET',
      `/api/v1/gates/${encodeURIComponent(gateId)}`,
    )
  ).body;
const closed = (gateId: string) =>
  until(
    () => detail(gateId),
    (gate) => gate.status !== 'open',
    `gate ${gateId} decided`,
  );

test('seat keyboard: roving tabindex, arrows, Enter selects and opens the inspector (I-08, I-07)', async ({
  page,
}) => {
  await office().login(page, officePath());
  const scene = page.getByTestId('office-scene');
  const seats = scene.locator('[data-testid^="seat-"][data-pose]');
  await expect
    .poll(() => seats.count(), { timeout: 20_000 })
    .toBeGreaterThan(1);
  // Only one seat is in the Tab order (roving tabindex).
  await expect(seats.and(page.locator('[tabindex="0"]'))).toHaveCount(1);
  await seats.and(page.locator('[tabindex="0"]')).focus();
  const focused = () =>
    page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    );
  const first = await focused();
  await expect(page.getByTestId(first)).toHaveCSS('outline-width', '3px');
  // Arrows move spatially; at an edge one direction may have no neighbour.
  let second = first;
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
    await page.keyboard.press(key);
    second = await focused();
    if (second !== first) break;
  }
  expect(second).toMatch(/^seat-/);
  expect(second).not.toBe(first);
  await expect(seats.and(page.locator('[tabindex="0"]'))).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(second)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('seat-inspector')).toBeVisible();
  await expect(page).toHaveURL(/seat=/);
  // Tab leaves the seats after one stop, passes the whiteboard, inbox and
  // your desk, then reaches the right column (the inspector).
  const reached: string[] = [];
  const isSeat = (id: string) => id.startsWith('seat-') && id.includes(':');
  for (let presses = 0; presses < 10; presses++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => ({
      id: document.activeElement?.getAttribute('data-testid') ?? '',
      inspector: !!document.activeElement?.closest(
        '[data-testid="seat-inspector"]',
      ),
    }));
    reached.push(at.id);
    if (at.inspector) break;
  }
  expect(reached.filter(isSeat), reached.join(' → ')).toEqual([]);
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('[data-testid="seat-inspector"]'),
    ),
    reached.join(' → '),
  ).toBe(true);
});

test('a lost runtime connection pauses with banners; reconnecting clears them (I-04)', async ({
  page,
}) => {
  await office().login(page, officePath());
  await expect(page.getByTestId('office-scene')).toBeVisible();
  await expect(page.getByTestId('banner-fake')).toBeVisible();
  await office().fake.setConnected(false);
  try {
    await expect(page.getByTestId('pause-runtime_unhealthy')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('health-runtime')).toBeVisible();
    // The paused workflow shows in the list too.
    expect((await readModel(office(), workflowId)).pausedReasons).toContain(
      'runtime_unhealthy',
    );
  } finally {
    await office().fake.setConnected(true);
  }
  await expect(page.getByTestId('pause-runtime_unhealthy')).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('health-runtime')).toHaveCount(0);
});

/** Picks the exception option through the UI and submits it. */
async function decideOption(
  page: Page,
  gate: GateView,
  optionId: string,
  input?: string,
): Promise<void> {
  await office().login(page, `/gates/${encodeURIComponent(gate.gateId)}`);
  await expect(page.getByTestId(`gate-page-${gate.gateId}`)).toBeVisible();
  await expect(page.getByTestId('option-submit')).toBeDisabled();
  await expectNoBlockingAxe(page, `${gate.exceptionKind} gate`);
  await page.getByTestId(`option-${optionId}`).check();
  if (input !== undefined) {
    // An option that needs input stays disabled until it has one.
    await expect(page.getByTestId('option-submit')).toBeDisabled();
    await page.getByTestId('option-input').selectOption(input);
  }
  await page.getByTestId('option-submit').click();
  await closed(gate.gateId);
}

test('exception gates and an escalated question are decided through the UI (I-15, I-16)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const viaUi = new Set<string>();
  const wanted = ['anomaly', 'workitem-failed', 'rework-limit', 'question'];
  const deadline = Date.now() + 200_000;
  while (!wanted.every((kind) => viaUi.has(kind))) {
    if (Date.now() > deadline)
      throw new Error(`Covered only ${[...viaUi].join(', ')}`);
    const open = (await gates(office(), workflowId)).filter(
      (gate) => gate.status === 'open',
    );
    for (const gate of open) {
      const full = await detail(gate.gateId);
      if (full.status !== 'open') continue;
      if (gate.kind === 'stage') {
        if (gate.stageKind === 'final-pr') continue;
        await office().api(
          'POST',
          `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
          {
            decision: 'approve',
            expectedVersion: full.version,
            ...(full.conclusion
              ? {
                  githubBodyHash:
                    full.conclusion.githubBodyHash ??
                    full.conclusion.renderedHash,
                }
              : {}),
          },
        );
        continue;
      }
      const kind = full.questionId ? 'question' : full.exceptionKind!;
      if (kind === 'question' && !viaUi.has(kind)) {
        // I-16: the gate hands over to the question page; answer in text.
        await office().login(page, `/gates/${encodeURIComponent(gate.gateId)}`);
        await page.getByTestId('gate-question-link').click();
        await expect(page).toHaveURL(/\/questions\//);
        await expect(page.getByTestId('question-submit')).toBeDisabled();
        await expectNoBlockingAxe(page, 'question page');
        await page
          .getByTestId('question-answer')
          .fill('Keep the existing behavior');
        await page.getByTestId('question-submit').click();
        await closed(gate.gateId);
        viaUi.add(kind);
      } else if (kind === 'anomaly' && !viaUi.has(kind)) {
        // The anomaly pause is visible on the office before the decision.
        await office().login(page, officePath());
        await expect(page.getByTestId('pause-anomaly')).toBeVisible();
        await expect(page.getByTestId(`need-${gate.gateId}`)).toBeVisible();
        await decideOption(page, full, 'continue');
        viaUi.add(kind);
      } else if (kind === 'workitem-failed' && !viaUi.has(kind)) {
        await decideOption(page, full, 'reassign', 'claude-code');
        viaUi.add(kind);
      } else if (kind === 'rework-limit' && !viaUi.has(kind)) {
        await decideOption(page, full, 'rework');
        viaUi.add(kind);
      } else if (kind === 'question') {
        await office().api(
          'POST',
          `/api/v1/questions/${encodeURIComponent(full.questionId!)}/answer`,
          { body: 'Keep the existing behavior' },
        );
      } else {
        const option =
          full.options.find((o) => o.optionId !== 'abort' && !o.input) ??
          full.options[0];
        if (!option) continue;
        await office().api(
          'POST',
          `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
          {
            decision: 'option',
            optionId: option.optionId,
            expectedVersion: full.version,
          },
        );
      }
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  // The decisions are the owner's, in the read model (GET /gates lists open ones).
  const decided = (await readModel(office(), workflowId)).gates.filter(
    (gate) => gate.kind === 'exception' && gate.decision?.by === 'user',
  );
  expect(decided.length).toBeGreaterThanOrEqual(4);
});
