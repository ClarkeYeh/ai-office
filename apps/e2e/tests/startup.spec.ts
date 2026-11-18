import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { HealthView } from '@ai-office/contracts/api';
import { Office, useOffice } from '../test-support/index.js';

const office = useOffice({ scenario: 'demo' });

test('start announces the fake runtime and owns runtime.json', async () => {
  expect(office().log).toContain('runtime: fake, scenario: demo');
  expect(office().port).not.toBe(4319);
  const runtime = JSON.parse(
    await readFile(join(office().home, 'runtime.json'), 'utf8'),
  ) as { port: number; pid: number };
  expect(runtime.port).toBe(office().port);
  // runtime.json belongs to the backend child, not the CLI wrapper.
  expect(runtime.pid).not.toBe(office().pid);
});

test('health reports the fake runtime and the demo template is loaded', async () => {
  const health = await office().api<HealthView>('GET', '/api/v1/health');
  expect(health.status).toBe(200);
  expect(health.body.runtime.mode).toBe('fake');
  const templates = await office().api<{
    valid: Array<{ id: string }>;
    invalid: unknown[];
  }>('GET', '/api/v1/templates');
  expect(templates.body.valid.map((entry) => entry.id)).toContain('demo');
  expect(templates.body.invalid).toEqual([]);
});

test('the built UI is served same-origin, including client-side routes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await office().login(page);
  await expect(page).toHaveTitle(/AI Office/);
  await expect(page.getByTestId('home-link')).toBeVisible();
  // health.runtime.mode === 'fake' reaches the UI as a banner (Q7).
  await expect(page.getByTestId('banner-fake')).toBeVisible();
  const deep = await page.goto(office().url + '/workflows/unknown');
  expect(deep?.status()).toBe(200);
  expect(deep?.headers()['content-type']).toContain('text/html');
  expect(errors).toEqual([]);
});

test('SIGTERM to the CLI stops the backend gracefully and releases the home', async () => {
  const second = await Office.start({ scenario: 'mainline' });
  const { home } = second;
  const result = await second.stop({ keepHome: true });
  expect(result, second.log).toEqual({
    code: 0,
    signal: null,
    runtimeRemoved: true,
  });
  await expect(readFile(join(home, 'runtime.json'))).rejects.toThrow();
  await second.stop(); // idempotent; now removes the home
  await expect(readFile(join(home, 'runtime.json'))).rejects.toThrow();
  expect(existsSync(home)).toBe(false);
});
