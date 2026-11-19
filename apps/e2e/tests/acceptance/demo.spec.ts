import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { GateView } from '@ai-office/contracts/api';
import {
  finalPrNumber,
  gates,
  isEnded,
  readModel,
  startWorkflow,
  until,
  useOffice,
} from '../../test-support/index.js';
import {
  dropStream,
  RECORD_SSE,
  sampleQuiet,
  seatStates,
  type SeatStates,
} from './live.js';

/**
 * M4-T16 acceptance on the `demo` scenario, end to end through the UI
 * (§2.3 I-02, I-03, I-07, I-10, I-12, I-13, I-14, I-20, I-22 and replay = live).
 * One workflow runs through every test in order. An observer tab stays on
 * the office the whole time and records seat states at quiet seqs; the last
 * test replays to those seqs and compares.
 */
const office = useOffice({ scenario: 'demo' });

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 1000 } });

/** tokens.css: --ink #262b44 (never --amber #feae34 for GitHub additions). */
const INK = 'rgb(38, 43, 68)';
/** Mirrors COLUMNS in apps/web/src/features/office/model/boardViewModel.ts. */
const COLUMNS = ['waiting', 'active', 'queued', 'review', 'merged'] as const;
let workflowId: string;
let observerContext: BrowserContext;
let observer: Page;
const live = new Map<number, SeatStates>();
const gateSeqs = new Set<number>();
let sampling: Promise<void> | undefined;
let stopSampling = false;

const openGate = async (
  stageKind: GateView['stageKind'],
  timeoutMs = 60_000,
): Promise<GateView> =>
  (
    await until(
      () => gates(office(), workflowId),
      (list) =>
        list.some(
          (gate) => gate.stageKind === stageKind && gate.status === 'open',
        ),
      `${stageKind} gate`,
      timeoutMs,
    )
  ).find((gate) => gate.stageKind === stageKind && gate.status === 'open')!;

const gateDetail = async (gateId: string) =>
  (
    await office().api<GateView>(
      'GET',
      `/api/v1/gates/${encodeURIComponent(gateId)}`,
    )
  ).body;

/** A gate open means the office is quiet: remember its seq for the replay check. */
async function markGateSeq(): Promise<void> {
  const model = await readModel(office(), workflowId);
  await expect
    .poll(async () => (await sampleQuiet(observer))?.seq ?? 0, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(model.lastSeq);
  gateSeqs.add((await sampleQuiet(observer))!.seq);
}

test.beforeAll(async ({ browser }) => {
  workflowId = await startWorkflow(office(), {
    templateId: 'demo',
    requirement: 'Acceptance: demo through the UI',
  });
  observerContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await observerContext.addInitScript(RECORD_SSE);
  observer = await observerContext.newPage();
  await office().login(
    observer,
    `/workflows/${encodeURIComponent(workflowId)}`,
  );
  await expect(observer.getByTestId('office-scene')).toBeVisible();
  sampling = (async () => {
    while (!stopSampling) {
      const sample = await sampleQuiet(observer).catch(() => null);
      if (sample && !live.has(sample.seq)) live.set(sample.seq, sample.states);
      await delay(150);
    }
  })();
});

test.afterAll(async () => {
  stopSampling = true;
  await sampling;
  await observerContext?.close();
});

test('meeting: messages are refused with a reason; the header and stage strip are live (I-02, I-03, I-10)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await office().login(page, `/workflows/${encodeURIComponent(workflowId)}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Acceptance: demo through the UI',
  );
  await expect(page.getByTestId('stage-strip')).toBeVisible();
  await expect(page.getByTestId('view-office')).toHaveAttribute(
    'aria-current',
    'page',
  );
  const model = await until(
    () => readModel(office(), workflowId),
    (value) =>
      value.seats.some(
        (seat) => seat.role === 'pm' && seat.state === 'working',
      ),
    'a meeting participant at work',
  );
  const pm = model.seats.find((seat) => seat.role === 'pm')!;
  const seat = page.getByTestId(`seat-${pm.seatId}`);
  await seat.click();
  await expect(seat).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('seat-inspector')).toBeVisible();
  await expect(page.getByTestId('seat-message-disabled')).toBeVisible();
  await expect(page.getByTestId('seat-message-send')).toBeDisabled();
});

test('conclusion gate: GitHub edit shows in the diff, 409 refetches, approve sends the GitHub version (I-12)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const gate = await openGate('meeting');
  await markGateSeq();
  const model = await readModel(office(), workflowId);
  const issue = model.artifacts.find(
    (artifact) =>
      artifact.kind === 'issue' && artifact.purpose === 'conclusion',
  )!;
  expect(issue?.number).toBeDefined();
  const body = (await gateDetail(gate.gateId)).conclusion!.githubBody!;
  await office().fake.editIssueBody(
    issue.number!,
    `${body}\n\nOwner note: added on GitHub\n`,
  );

  await office().login(page, `/workflows/${encodeURIComponent(workflowId)}`);
  // Needs (I-02): the open gate is listed and the stage strip links to it (I-03).
  await expect(page.getByTestId(`need-${gate.gateId}`)).toBeVisible();
  await page.getByTestId(`stage-gate-${gate.gateId}`).click();
  await expect(page.getByTestId(`gate-page-${gate.gateId}`)).toBeVisible();
  await expect(page.getByTestId('conclusion-issue-link')).toBeVisible();
  // Three views: GitHub now, the AI Office original, and the diff.
  await page.getByTestId('conclusion-view-github').click();
  // The GitHub view renders the parsed sections of the current issue body.
  await expect(page.getByTestId('conclusion-panel-github')).toContainText(
    'Deliver the office demo',
  );
  await page.getByTestId('conclusion-view-original').click();
  const original = page.getByTestId('conclusion-panel-original');
  await expect(original).toContainText('Deliver the office demo');
  await expect(original).not.toContainText('Owner note');
  await expect(page.getByTestId('gate-fact-reruns')).toBeAttached();
  await page.getByTestId('conclusion-view-diff').click();
  const added = page.locator(
    '[data-testid="conclusion-diff"] li[data-kind="added"]',
  );
  const note = added.filter({ hasText: 'Owner note: added on GitHub' });
  await expect(note).toHaveCount(1);
  // GitHub additions use the ink bar, never amber (I-12).
  await expect(note).toHaveCSS('border-left-color', INK);
  // The reader never sees the engine's section or command markers.
  await expect(page.getByTestId('conclusion-diff')).not.toContainText(
    'ai-office:',
  );

  // GitHub moves again after the page loaded: approving the version on screen
  // gets 409 gate_content_changed; the page says so and refetches.
  const before = (await gateDetail(gate.gateId)).version;
  await office().fake.editIssueBody(
    issue.number!,
    `${body}\n\nOwner note: added on GitHub\n\nSecond edit\n`,
  );
  await page.getByTestId('gate-approve').click();
  await expect(page.getByTestId('gate-notice')).toBeVisible();
  expect((await gateDetail(gate.gateId)).status).toBe('open');
  // The observed edit bumps the gate version; the page follows it.
  const after = await until(
    () => gateDetail(gate.gateId),
    (detail) => detail.version > before,
    'gate version after the GitHub edit',
  );
  await expect(page.getByTestId('gate-fact-version')).toContainText(
    `v${after.version}`,
  );
  await expect(added.filter({ hasText: 'Second edit' })).toHaveCount(1);

  await page.getByTestId('gate-approve').click();
  await expect
    .poll(async () => (await gateDetail(gate.gateId)).status)
    .not.toBe('open');
  const decided = await gateDetail(gate.gateId);
  expect(decided.decision).toMatchObject({ decision: 'approve', by: 'user' });
});

test('task split gate: dependency precheck, then an edited title is submitted (I-13)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const gate = await openGate('planning');
  await markGateSeq();
  await office().login(page, `/gates/${encodeURIComponent(gate.gateId)}`);
  await expect(page.getByTestId('tasks-approve')).toBeEnabled();

  await page.getByTestId('item-dependent-deps').fill('feature, nowhere');
  await expect(page.getByRole('alert')).toContainText('nowhere');
  await expect(page.getByTestId('tasks-approve')).toBeDisabled();
  await page.getByTestId('item-dependent-deps').fill('feature');
  await page
    .getByTestId('item-feature-title')
    .fill('Implement feature (edited)');
  await page.getByTestId('tasks-approve').click();
  await expect
    .poll(async () => (await gateDetail(gate.gateId)).status)
    .not.toBe('open');
  const workItems = await until(
    () => readModel(office(), workflowId),
    (value) => value.workItems.length > 0,
    'work items',
  );
  expect(
    workItems.workItems.find((item) => item.key === 'feature')?.title,
  ).toBe('Implement feature (edited)');
});

test('seat message: a live worker gets the instruction as an event (I-10)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await office().login(page, `/workflows/${encodeURIComponent(workflowId)}`);
  let sent = false;
  for (let tries = 0; !sent && tries < 4; tries++) {
    const model = await until(
      () => readModel(office(), workflowId),
      (value) =>
        value.seats.some(
          (seat) =>
            seat.role === 'engineer' &&
            (seat.state === 'working' || seat.state === 'waiting_input'),
        ),
      'a live worker',
      40_000,
    );
    const worker = model.seats.find(
      (seat) =>
        seat.role === 'engineer' &&
        (seat.state === 'working' || seat.state === 'waiting_input'),
    )!;
    await page.getByTestId(`seat-${worker.seatId}`).click();
    await expect(page.getByTestId('seat-inspector')).toBeVisible();
    const send = page.getByTestId('seat-message-send');
    await page.getByTestId('seat-message-body').fill('Please keep it small');
    if (!(await send.isEnabled())) continue;
    await send.click();
    await expect(page.getByTestId('seat-message-result')).toBeVisible();
    sent = await until(
      async () =>
        (
          await office().api<{ events: Array<{ type: string }> }>(
            'GET',
            `/api/v1/workflows/${encodeURIComponent(workflowId)}/events?afterSeq=0&limit=500`,
          )
        ).body.events.some((event) => event.type === 'message.instruction'),
      (value) => value,
      'message.instruction event',
      5_000,
    ).catch(() => false);
  }
  expect(sent).toBe(true);
});

test('the live tab drops offline mid-run and resumes with Last-Event-ID (I-22)', async () => {
  test.setTimeout(60_000);
  const seq = async () =>
    observer.evaluate(
      () => (window as unknown as { __aioSse: { seq: number } }).__aioSse.seq,
    );
  await observerContext.setOffline(true);
  await dropStream(observer);
  // A dead stream is reported; reconnects fail while offline.
  await expect(observer.getByTestId('banner-connection')).toBeVisible({
    timeout: 30_000,
  });
  const before = await seq();
  // Events keep happening while the tab is away.
  await until(
    () => readModel(office(), workflowId),
    (model) => model.lastSeq > before + 5,
    'events while offline',
  );
  const resumed = observer.waitForRequest(
    (request) =>
      request.url().includes('afterSeq=') &&
      new URL(request.url()).searchParams.get('afterSeq') === String(before),
    { timeout: 30_000 },
  );
  await observerContext.setOffline(false);
  // The app reconnects from its cursor (its Last-Event-ID): afterSeq = last seen.
  await resumed;
  await expect(observer.getByTestId('banner-connection')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect.poll(seq, { timeout: 15_000 }).toBeGreaterThan(before + 5);
  // No gap and no repeat across the drop (one workflow: global seqs are dense).
  const seqs = await observer.evaluate(
    () => (window as unknown as { __aioSse: { seqs: number[] } }).__aioSse.seqs,
  );
  const across = seqs.slice(seqs.indexOf(before));
  expect(across.length).toBeGreaterThan(5);
  expect(across).toEqual(
    Array.from({ length: across.length }, (_, i) => before + i),
  );
});

test('board: same read model, five columns and seat lanes (I-11)', async ({
  page,
}) => {
  await office().login(page, `/workflows/${encodeURIComponent(workflowId)}`);
  await page.getByTestId('office-whiteboard').click();
  await expect(page).toHaveURL(/\/board/);
  await expect(page.getByTestId('office-board')).toBeVisible();
  for (const column of COLUMNS)
    await expect(page.getByTestId(`board-column-${column}`)).toBeVisible();
  await expect(page.locator('[data-testid^="board-column-"]')).toHaveCount(5);
  // Every work item of the read model is a card in exactly one column.
  const model = await readModel(office(), workflowId);
  for (const item of model.workItems)
    await expect(page.getByTestId(`board-card-${item.key}`)).toHaveCount(1);
  await expect(
    page.locator('[data-testid^="board-lane-"]').first(),
  ).toBeVisible();
});

test('final PR: request changes, then the explicit owner merge opens the door with one confetti (I-14, I-06)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const first = await openGate('final-pr', 90_000);
  await markGateSeq();
  await office().login(page, `/gates/${encodeURIComponent(first.gateId)}`);
  await expect(page.getByTestId('final-pr-link')).toBeVisible();
  await page.getByTestId('final-feedback').fill('Please add a changelog entry');
  await page.getByTestId('final-reject').click();
  await expect
    .poll(async () => (await gateDetail(first.gateId)).status)
    .not.toBe('open');

  const second = await until(
    () => gates(office(), workflowId),
    (list) =>
      list.some(
        (gate) =>
          gate.stageKind === 'final-pr' &&
          gate.status === 'open' &&
          gate.gateId !== first.gateId,
      ),
    'the reopened final PR gate',
    60_000,
  );
  expect(second.length).toBeGreaterThan(0);
  await markGateSeq();
  const number = await until(
    () => finalPrNumber(office(), workflowId),
    (value) => value !== undefined,
    'final PR number',
  );

  // Watch the merge happen live on the office (no reduced motion here).
  await page.goto(
    office().url + `/workflows/${encodeURIComponent(workflowId)}`,
  );
  await expect(page.getByTestId('office-door')).toHaveAttribute(
    'data-open',
    'false',
  );
  await delay(1500);
  expect((await readModel(office(), workflowId)).status).toBe('running');
  // Count effect mounts while the merge plays (a snapshot could miss or
  // double-count a short effect).
  await page.evaluate(() => {
    const mounts: Record<string, number> = {};
    Object.defineProperty(window, '__aioMounts', { value: mounts });
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          for (const element of [
            node,
            ...Array.from(node.querySelectorAll<HTMLElement>('[data-testid]')),
          ]) {
            const id = element.dataset['testid'];
            if (id?.startsWith('effect-')) mounts[id] = (mounts[id] ?? 0) + 1;
          }
        }
    }).observe(document.body, { subtree: true, childList: true });
  });
  await office().fake.mergeFinalPr(number!);
  await expect(page.getByTestId('office-door')).toHaveAttribute(
    'data-open',
    'true',
  );
  const ended = await until(
    () => readModel(office(), workflowId),
    isEnded,
    'completion',
  );
  expect(ended.status).toBe('completed');
  await expect(page.locator('[data-testid^="effect-"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  const mounts = await page.evaluate(
    () =>
      (window as unknown as { __aioMounts: Record<string, number> })
        .__aioMounts,
  );
  expect(mounts).toMatchObject({ 'effect-door': 1, 'effect-confetti': 1 });

  // A reload catches up silently: the door is open, nothing replays (I-06).
  await page.reload();
  await expect(page.getByTestId('office-door')).toHaveAttribute(
    'data-open',
    'true',
  );
  await delay(1000);
  await expect(page.locator('[data-testid^="effect-"]')).toHaveCount(0);
});

test('reload and a fresh tab agree with the long-lived live tab (I-22)', async ({
  page,
}) => {
  const final = await readModel(office(), workflowId);
  await expect
    .poll(async () => (await sampleQuiet(observer))?.seq ?? 0)
    .toBe(final.lastSeq);
  const liveStates = await seatStates(observer);
  await office().login(page, `/workflows/${encodeURIComponent(workflowId)}`);
  await expect(page.getByTestId('office-scene')).toBeVisible();
  await expect.poll(() => seatStates(page)).toEqual(liveStates);
  await observer.reload();
  await expect(observer.getByTestId('office-scene')).toBeVisible();
  await expect.poll(() => seatStates(observer)).toEqual(liveStates);
  live.set(final.lastSeq, liveStates);
});

test('replay equals live at ≥ 10 seqs, including every gate opening (I-20)', async () => {
  test.setTimeout(180_000);
  stopSampling = true;
  await sampling;
  const seqs = [...live.keys()].sort((a, b) => a - b);
  for (const seq of gateSeqs)
    expect(live.has(seq), `gate seq ${seq}`).toBe(true);
  // Every gate opening plus an even spread of the rest.
  const others = seqs.filter((seq) => !gateSeqs.has(seq));
  const step = Math.max(1, Math.floor(others.length / 10));
  const chosen = [
    ...new Set([
      ...gateSeqs,
      ...others.filter((_, index) => index % step === 0),
      seqs.at(-1)!,
    ]),
  ].sort((a, b) => a - b);
  expect(chosen.length).toBeGreaterThanOrEqual(10);

  const path = `/workflows/${encodeURIComponent(workflowId)}`;
  await observer.goto(office().url + path + '/timeline');
  await observer.getByTestId('timeline-open').click();
  await expect(observer.getByTestId('banner-replay')).toBeVisible();
  const scrubber = observer.getByTestId('timeline-scrubber');
  await expect(scrubber).toBeEnabled({ timeout: 30_000 });
  const count = Number(await scrubber.getAttribute('max')) + 1;
  const seqAt = async (index: number) => {
    await scrubber.fill(String(index));
    const text = (await scrubber.getAttribute('aria-valuetext')) ?? '';
    return Number(/seq (\d+)/.exec(text)?.[1]);
  };

  let compared = 0;
  for (const seq of chosen) {
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((await seqAt(mid)) <= seq) low = mid;
      else high = mid - 1;
    }
    expect(await seqAt(low), `seq ${seq} is a timeline point`).toBe(seq);
    // Client-side navigation keeps the replay (it belongs to realtime).
    await observer.getByTestId('view-office').click();
    await expect(observer.getByTestId('office-scene')).toBeVisible();
    await expect(observer.getByTestId('banner-replay')).toBeVisible();
    await expect
      .poll(() => seatStates(observer), { message: `seats at seq ${seq}` })
      .toEqual(live.get(seq));
    compared++;
    await observer.getByTestId('view-timeline').click();
    await expect(scrubber).toBeEnabled();
  }
  expect(compared).toBeGreaterThanOrEqual(10);

  // Back to live: the replay banner goes and the final state returns.
  await observer.getByTestId('timeline-live').click();
  await expect(observer.getByTestId('banner-replay')).toHaveCount(0);
});
