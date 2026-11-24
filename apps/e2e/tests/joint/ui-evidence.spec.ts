import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type { WorkflowReadModel } from '@ai-office/contracts/api';
import { seatStates, type SeatStates } from '../acceptance/live.js';

/**
 * M5-T17 UI evidence (M5_PLAN §5 T17, §2.3.4 #11 and #15): a read-only pass
 * over an EXISTING backend after the joint run. It never starts or stops a
 * process, never posts, and never clicks a decision; the only side effect is
 * the session the `ai-office open` login URL creates.
 *
 *   AIO_T17_BACKEND_URL   backend origin (http://127.0.0.1:<port>, never 4319)
 *   AIO_T17_LOGIN_URL     `ai-office open --print` output for that backend
 *   AIO_T17_RESTART_SEQ   seq of the K / K′ trigger (report `restart.triggerSeq`)
 *   AIO_T17_WORKFLOW_ID   optional when the home holds exactly one workflow
 *   AIO_T17_ALLOW_ZERO_TOKENS=1   the fake world reports no usage
 *
 * Skipped unless the first three are set (it is not a CI test). See README.md.
 */
const env = {
  backend: process.env.AIO_T17_BACKEND_URL,
  login: process.env.AIO_T17_LOGIN_URL,
  restartSeq: process.env.AIO_T17_RESTART_SEQ,
  workflowId: process.env.AIO_T17_WORKFLOW_ID,
  allowZeroTokens: process.env.AIO_T17_ALLOW_ZERO_TOKENS === '1',
};
const OWNER_PORT = '4319';
/** Mirrors COLUMNS in apps/web/src/features/office/model/boardViewModel.ts. */
const COLUMNS = ['waiting', 'active', 'queued', 'review', 'merged'] as const;

interface Event {
  seq: number;
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

test.describe.configure({ mode: 'serial' });
test.skip(
  !env.backend || !env.login || !env.restartSeq,
  'live UI evidence: set AIO_T17_BACKEND_URL, AIO_T17_LOGIN_URL and AIO_T17_RESTART_SEQ',
);
// Traces and screenshots would keep agent text from the live run on disk.
test.use({
  viewport: { width: 1440, height: 1000 },
  trace: 'off',
  screenshot: 'off',
});

let backend: string;
let context: BrowserContext;
let page: Page;
let request: APIRequestContext;
let workflowId: string;
let model: WorkflowReadModel;
let events: Event[];
let restartSeq: number;
let live: SeatStates;

async function get<T>(path: string): Promise<T> {
  const response = await request.get(backend + path, {
    headers: { origin: backend },
  });
  expect(response.status(), `GET ${path.split('?')[0]}`).toBe(200);
  return (await response.json()) as T;
}

async function allEvents(): Promise<Event[]> {
  const all: Event[] = [];
  for (let after = 0; ;) {
    const page = await get<{ events: Event[]; nextAfterSeq?: number }>(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/events?afterSeq=${after}&limit=500`,
    );
    all.push(...page.events);
    if (page.nextAfterSeq === undefined || !page.events.length) return all;
    after = page.nextAfterSeq;
  }
}

/** Stable, non-empty scene: two equal reads a moment apart. */
async function settledSeats(target: Page): Promise<SeatStates> {
  let previous = '';
  let states: SeatStates = {};
  await expect
    .poll(
      async () => {
        states = await seatStates(target);
        const text = JSON.stringify(states);
        const stable = text === previous && Object.keys(states).length > 0;
        previous = text;
        return stable;
      },
      { intervals: [250], timeout: 20_000, message: 'office scene settles' },
    )
    .toBe(true);
  return states;
}

const path = () => `/workflows/${encodeURIComponent(workflowId)}`;
const scrubber = () => page.getByTestId('timeline-scrubber');
/** Seat ids the office scene currently draws. */
const sceneSeatIds = async (): Promise<Set<string>> =>
  new Set(
    (
      await page
        .getByTestId('office-scene')
        .locator('[data-testid^="seat-"][data-pose]')
        .evaluateAll((list) =>
          list.map((element) => (element as HTMLElement).dataset['testid']!),
        )
    ).map((id) => id.slice('seat-'.length)),
  );

/** Ordinal → seq, as the scrubber announces it. */
async function seqAt(index: number): Promise<number> {
  await scrubber().fill(String(index));
  const text = (await scrubber().getAttribute('aria-valuetext')) ?? '';
  return Number(/seq (\d+)/.exec(text)?.[1]);
}

/** Seeks the replay to the event with `seq` and shows the office (client-side). */
async function replayOffice(seq: number): Promise<void> {
  const index = events.findIndex((e) => e.seq === seq);
  expect(index, `seq ${seq} is a workflow event`).toBeGreaterThanOrEqual(0);
  expect(await seqAt(index), `ordinal ${index}`).toBe(seq);
  await page.getByTestId('view-office').click();
  await expect(page.getByTestId('office-scene')).toBeVisible();
  await expect(page.getByTestId('banner-replay')).toBeVisible();
}

async function backToTimeline(): Promise<void> {
  await page.getByTestId('view-timeline').click();
  await expect(scrubber()).toBeEnabled();
}

test.beforeAll(async ({ browser }) => {
  const origin = new URL(env.backend!);
  const login = new URL(env.login!);
  expect(origin.hostname).toBe('127.0.0.1');
  expect(origin.port).not.toBe(OWNER_PORT);
  expect(login.origin, 'login URL belongs to the backend').toBe(origin.origin);
  expect(login.pathname).toBe('/auth/bootstrap');
  backend = origin.origin;
  restartSeq = Number(env.restartSeq);
  expect(Number.isSafeInteger(restartSeq) && restartSeq > 0).toBe(true);

  context = await browser.newContext({ reducedMotion: 'reduce' });
  page = await context.newPage();
  request = context.request;
  // Never echo the one-time code into a report.
  await page.goto(login.href).catch(() => {
    throw new Error('Login navigation failed');
  });
  await expect(page.getByTestId('home-link')).toBeVisible();
  expect(page.url()).not.toContain('code=');

  const { workflows } = await get<{ workflows: { workflowId: string }[] }>(
    '/api/v1/workflows',
  );
  if (env.workflowId) workflowId = env.workflowId;
  else {
    expect(workflows, 'one workflow, or set AIO_T17_WORKFLOW_ID').toHaveLength(
      1,
    );
    workflowId = workflows[0]!.workflowId;
  }
  model = (
    await get<{ readModel: WorkflowReadModel }>(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
    )
  ).readModel;
  events = await allEvents();
  expect(events.at(-1)?.seq).toBe(model.lastSeq);
});

test.afterAll(async () => {
  await context?.close();
});

test('the live office shows every agent that worked past the meeting', async () => {
  await page.goto(backend + path());
  await expect(page.getByTestId('office-scene')).toBeVisible();
  live = await settledSeats(page);
  const spawns = events.filter((e) => e.type === 'seat.spawned');
  const spawned = new Set(spawns.map((e) => String(e.payload.seatId)));
  expect(spawned.size).toBeGreaterThan(0);
  expect(new Set(model.seats.map((s) => s.seatId))).toEqual(spawned);
  // The scene hides meeting chairs once their occupant left (OfficeScene
  // `visibleSeats`); each of those is checked at its spawn on the timeline.
  const beyondMeeting = new Set(
    spawns
      .filter((e) => e.payload.stageId !== 'meeting')
      .map((e) => String(e.payload.seatId)),
  );
  expect(beyondMeeting.size).toBeGreaterThan(0);
  for (const seatId of beyondMeeting)
    expect(live[`seat-${seatId}`], `seat ${seatId}`).toBeDefined();
  const shown = await sceneSeatIds();
  for (const seatId of shown) expect(spawned).toContain(seatId);
});

test('token usage shows numbers and the budget is disabled', async () => {
  const usage = page.getByTestId('token-usage');
  await expect(usage).toBeVisible();
  const shown = Number(
    ((await usage.locator('strong').textContent()) ?? '').replace(/[^\d]/g, ''),
  );
  expect(shown).toBe(model.usage.total.budgetTokens);
  if (!env.allowZeroTokens) expect(shown).toBeGreaterThan(0);
  expect(
    (model.limits as { budgetEnforcement?: string }).budgetEnforcement,
  ).toBe('off');
  await expect(usage.getByText('預算：停用')).toBeVisible();
});

test('the board and every gate page open', async () => {
  await page.goto(backend + path() + '/board');
  await expect(page.getByTestId('office-board')).toBeVisible();
  for (const column of COLUMNS)
    await expect(page.getByTestId(`board-column-${column}`)).toBeVisible();
  for (const item of model.workItems)
    await expect(page.getByTestId(`board-card-${item.key}`)).toHaveCount(1);
  expect(model.gates.length).toBeGreaterThan(0);
  for (const gate of model.gates) {
    await page.goto(backend + `/gates/${encodeURIComponent(gate.gateId)}`);
    await expect(page.getByTestId(`gate-page-${gate.gateId}`)).toBeVisible();
  }
});

test('timeline: waiting seats, continuity across the restart, last frame = live', async () => {
  test.setTimeout(300_000);
  await page.goto(backend + path() + '/timeline');
  await page.getByTestId('timeline-open').click();
  await expect(page.getByTestId('banner-replay')).toBeVisible();
  await expect(scrubber()).toBeEnabled({ timeout: 60_000 });

  // One point per workflow event, in order: nothing lost or doubled by the
  // restart. Exact around the restart, an even spread elsewhere.
  const count = Number(await scrubber().getAttribute('max')) + 1;
  expect(count).toBe(events.length);
  expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  const restart = events.findIndex((e) => e.seq === restartSeq);
  expect(restart, 'restart seq is a workflow event').toBeGreaterThan(0);
  expect(restart).toBeLessThan(events.length - 1);
  const step = Math.max(1, Math.floor(events.length / 40));
  const ordinals = new Set([
    ...Array.from(events.keys()).filter(
      (i) => i % step === 0 || Math.abs(i - restart) <= 10,
    ),
    events.length - 1,
  ]);
  for (const index of ordinals)
    expect(await seqAt(index), `ordinal ${index}`).toBe(events[index]!.seq);

  // Every agent appears in the office at its first spawn.
  const firstSpawn = new Map<string, number>();
  for (const e of events)
    if (e.type === 'seat.spawned' && !firstSpawn.has(String(e.payload.seatId)))
      firstSpawn.set(String(e.payload.seatId), e.seq);
  for (const [seatId, seq] of firstSpawn) {
    await replayOffice(seq);
    await expect(
      page.getByTestId(`seat-${seatId}`),
      `seat ${seatId} at seq ${seq}`,
    ).toHaveAttribute('data-pose', /.+/);
    await backToTimeline();
  }

  // Across the restart no seat leaves the office.
  let before: Set<string> | undefined;
  for (const index of [restart - 1, restart, restart + 1]) {
    await replayOffice(events[index]!.seq);
    await expect
      .poll(async () => (await sceneSeatIds()).size)
      .toBeGreaterThan(0);
    const seats = await sceneSeatIds();
    if (before)
      for (const seatId of before)
        expect(seats, `seq ${events[index]!.seq}`).toContain(seatId);
    before = seats;
    await backToTimeline();
  }

  // Each waiting_input seq shows that seat waiting.
  const waiting = events.filter(
    (e) => e.type === 'seat.status' && e.payload.state === 'waiting_input',
  );
  expect(waiting.length).toBeGreaterThan(0);
  for (const e of waiting) {
    const seat = model.seats.find((s) =>
      s.attempts.some((a) => a.attemptId === e.payload.attemptId),
    );
    expect(seat, `seat of the attempt waiting at seq ${e.seq}`).toBeDefined();
    await replayOffice(e.seq);
    const scene = page.getByTestId(`seat-${seat!.seatId}`);
    await expect(scene).toHaveAttribute('data-state', 'waiting_input');
    await expect(scene).toHaveAttribute('data-pose', 'needs-you');
    await backToTimeline();
  }

  // The last frame equals the live office (M4's replay = live method).
  await replayOffice(events.at(-1)!.seq);
  await expect
    .poll(() => seatStates(page), { message: 'last frame = live' })
    .toEqual(live);
  await backToTimeline();
  await page.getByTestId('timeline-live').click();
  await expect(page.getByTestId('banner-replay')).toHaveCount(0);
});
