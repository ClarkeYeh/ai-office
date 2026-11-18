import type { Page } from '@playwright/test';

/**
 * Live-state recording for the replay check (M4_PLAN §7.1 "回放一致"). The
 * init script records the highest domain-event seq the page's EventSource
 * delivered; a sample is taken only after the stream has been quiet long
 * enough for the store and React to have applied every delivered event.
 */
export const RECORD_SSE = () => {
  const state = { seq: 0, at: 0 };
  Object.defineProperty(window, '__aioSse', { value: state });
  const add = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (
    this: EventSource,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type !== 'domain' || typeof listener !== 'function')
      return add.call(this, type, listener, options);
    return add.call(
      this,
      type,
      (event: Event) => {
        try {
          const seq = (JSON.parse(String((event as MessageEvent).data)) as {
            seq?: unknown;
          }).seq;
          if (typeof seq === 'number' && seq > state.seq) {
            state.seq = seq;
            state.at = performance.now();
          }
        } catch {
          /* the app ignores malformed frames too */
        }
        listener.call(this, event);
      },
      options,
    );
  } as typeof EventSource.prototype.addEventListener;
};

/**
 * The scene as data: every `data-testid` element of the office scene (effects
 * excluded, they only exist while playing) with its `data-*` attributes.
 * Labels are left out: they carry elapsed time, which replay cannot match.
 */
export type SeatStates = Record<string, string>;

export async function seatStates(page: Page): Promise<SeatStates> {
  return page.evaluate(() => {
    const states: Record<string, string> = {};
    const scene = document.querySelector('[data-testid="office-scene"]');
    if (!scene) return states;
    for (const element of Array.from(
      scene.querySelectorAll<HTMLElement>('[data-testid]'),
    )) {
      const id = element.dataset['testid']!;
      if (id.startsWith('effect-') || id === 'office-effects') continue;
      states[id] = Object.entries(element.dataset)
        .filter(([key]) => key !== 'testid')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    }
    return states;
  });
}

/**
 * One sample when the stream has been quiet for `quietMs` and the seq did not
 * move while the DOM was read (two animation frames after the quiet window).
 */
export async function sampleQuiet(
  page: Page,
  quietMs = 600,
): Promise<{ seq: number; states: SeatStates } | null> {
  const before = await page.evaluate(
    async (quiet) => {
      const sse = (window as unknown as { __aioSse: { seq: number; at: number } })
        .__aioSse;
      if (!sse.seq || performance.now() - sse.at < quiet) return null;
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
      return sse.seq;
    },
    quietMs,
  );
  if (before === null) return null;
  const states = await seatStates(page);
  const after = await page.evaluate(
    () =>
      (window as unknown as { __aioSse: { seq: number } }).__aioSse.seq,
  );
  if (after !== before || !Object.keys(states).length) return null;
  return { seq: before, states };
}
