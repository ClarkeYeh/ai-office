import { expect, test } from '@playwright/test';
import type { RepoView } from '@ai-office/contracts/api';
import { readModel, until, useOffice } from '../test-support/index.js';

/**
 * `pnpm e2e:fps` (§7.1, milestone acceptance on an M1 Mac): ten live agents
 * from `load-10`, 60 seconds of frame timings from the Chrome compositor,
 * fewer than 5% dropped frames. Not part of CI.
 */
const office = useOffice({ scenario: 'load-10' });
/** Defaults to the office of a running load-10 workflow. */
const PATH = process.env.AIO_FPS_PATH;
const SECONDS = Number(process.env.AIO_FPS_SECONDS ?? 60);
const FRAME_MS = 1000 / 60;

test('load-10 keeps dropped frames under 5%', async ({ page }, testInfo) => {
  test.setTimeout((SECONDS + 90) * 1000);
  let path = PATH;
  if (path === undefined) {
    // Ten agents at once: skip the optional gates and wait for the workers.
    const repos = await office().api<{ repos: RepoView[] }>(
      'GET',
      '/api/v1/repos',
    );
    const started = await office().api<{ workflowId: string }>(
      'POST',
      '/api/v1/workflows',
      {
        templateId: 'load-10',
        repoId: repos.body.repos[0]!.repoId,
        requirement: 'Frame timing under load',
        gateToggles: { conclusion: false, 'task-split': false },
      },
    );
    expect(started.status).toBe(201);
    const workflowId = started.body.workflowId;
    await until(
      () => readModel(office(), workflowId),
      (model) =>
        model.seats.filter(
          (seat) => seat.state === 'working' || seat.state === 'waiting_input',
        ).length >= 9,
      'nine live workers',
      90_000,
    );
    path = `/workflows/${encodeURIComponent(workflowId)}`;
  }
  await office().login(page, path);
  await expect(page.locator('#root')).not.toBeEmpty();
  if (PATH === undefined)
    await expect(page.getByTestId('office-scene')).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  // Frame intervals as seen by requestAnimationFrame over the window.
  const intervals = await page.evaluate(
    (ms) =>
      new Promise<number[]>((done) => {
        const samples: number[] = [];
        let last = performance.now();
        const end = last + ms;
        const tick = (now: number) => {
          samples.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else done(samples);
        };
        requestAnimationFrame(tick);
      }),
    SECONDS * 1000,
  );
  const { metrics } = await cdp.send('Performance.getMetrics');
  // An interval spanning n frame slots dropped n - 1 frames.
  const slots = intervals.reduce(
    (sum, ms) => sum + Math.max(1, Math.round(ms / FRAME_MS)),
    0,
  );
  const dropped = slots - intervals.length;
  const ratio = dropped / slots;
  const sorted = [...intervals].sort((a, b) => a - b);
  const report = {
    path,
    seconds: SECONDS,
    frames: intervals.length,
    dropped,
    droppedRatio: Number(ratio.toFixed(4)),
    p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2)),
    taskDuration: metrics.find((metric) => metric.name === 'TaskDuration')
      ?.value,
  };
  await testInfo.attach('fps.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(JSON.stringify(report));
  expect(ratio).toBeLessThan(0.05);
});
