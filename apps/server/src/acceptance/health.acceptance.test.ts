import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, office, until } from './test-support/harness.js';
import type { Json } from './test-support/harness.js';

afterEach(closeAll);

const COMPONENTS = ['runtime', 'scm', 'store', 'usage'] as const;
/** The web's health banners (`health-*`, `banner-unverified`) render from these. */
const bannerFree = (health: Json) =>
  COMPONENTS.every((c) => health[c].status === 'healthy') &&
  health.runtime.verified === true;

const healthEvents = (dataDir: string): Json[] => {
  const db = new DatabaseSync(`${dataDir}/data/ai-office.sqlite`);
  try {
    return (
      db
        .prepare('SELECT event_json FROM events WHERE workflow_id IS NULL')
        .all() as { event_json: string }[]
    )
      .map((row) => JSON.parse(row.event_json) as Json)
      .filter((event) => event.type === 'health.changed');
  } finally {
    db.close();
  }
};

/*
 * FX5: a fully healthy fake instance publishes every component's actual
 * health and runtimeVerified at startup, so the UI shows no health or
 * unverified banners; a restart with unchanged health appends nothing.
 */
describe('startup health publication (FX5)', () => {
  it('serves healthy, verified health within the startup window and stays idempotent across a restart', async () => {
    const o = await office();
    const read = async () => (await o.ui.call('GET', '/api/v1/health')).body;
    const health = await until(read, bannerFree, 'healthy health', 2_000);
    expect(health.status).toBe('healthy');
    expect(health.runtime.mode).toBe('fake');
    for (const component of COMPONENTS)
      expect(health[component].checkedAt).toEqual(expect.any(String));
    const published = healthEvents(o.dataDir);
    expect(published.map((e) => e.payload.component).sort()).toEqual([
      ...COMPONENTS,
    ]);

    await o.restart();
    expect(bannerFree(await read())).toBe(true);
    expect(healthEvents(o.dataDir)).toHaveLength(published.length);
  });
});
