import { openOffice } from '../test-support/open.js';
import { expect, test } from '@playwright/test';
import { useOffice } from '../test-support/index.js';

const office = useOffice({ scenario: 'mainline' });

test.describe.configure({ mode: 'serial' });

test('the bootstrap URL logs the browser in once and lands on /', async ({
  page,
  context,
}) => {
  const bootstrap = office().takeBootstrapUrl();
  const response = await page.goto(bootstrap);
  expect(response?.ok()).toBe(true);
  expect(new URL(page.url()).pathname).toBe('/');
  // The one-time code must not stay in the address bar or history.
  expect(page.url()).not.toContain('code=');
  await expect(page.getByTestId('home-link')).toBeVisible();

  const session = (await context.cookies(office().url)).find(
    (cookie) => cookie.name === 'aio_session',
  );
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  office().adoptSession(session!.value);

  const health = await page.request.get(office().url + '/api/v1/health');
  expect(health.status()).toBe(200);

  // Reusing the consumed code in a fresh browser grants no session.
  const other = await context.browser()!.newContext();
  try {
    const reused = await other.request.get(bootstrap, { maxRedirects: 0 });
    expect(reused.status()).toBeGreaterThanOrEqual(400);
    expect(reused.headers()['set-cookie']).toBeUndefined();
    const denied = await other.request.get(office().url + '/api/v1/health');
    expect(denied.status()).toBe(401);
    const anonymous = await other.newPage();
    await anonymous.goto(office().url + '/');
    await expect(anonymous.getByTestId('auth-required')).toBeVisible();
  } finally {
    await other.close();
  }
});

test('the adopted browser session authorizes REST calls', async () => {
  const health = await office().api<{ runtime: { mode: string } }>(
    'GET',
    '/api/v1/health',
  );
  expect(health.status).toBe(200);
  expect(health.body.runtime.mode).toBe('fake');
});

test('an invalid bootstrap code is rejected without a cookie', async ({
  request,
}) => {
  const response = await request.get(
    office().url + '/auth/bootstrap?code=not-a-valid-code',
    { maxRedirects: 0 },
  );
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(response.headers()['set-cookie']).toBeUndefined();
});

test('the API and dev-fake controls refuse requests without a session', async ({
  request,
}) => {
  expect((await request.get(office().url + '/api/v1/workflows')).status()).toBe(
    401,
  );
  const merge = await request.post(
    office().url + '/dev/fake/scm/merge-final-pr',
    { data: { number: 1 }, headers: { origin: office().url } },
  );
  expect(merge.status()).toBe(401);
});

test('ai-office open logs in again after the browser session is invalidated', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto(office().url);
  await expect(page.getByTestId('auth-required')).toBeVisible();
  await expect(page.getByTestId('auth-required')).toContainText(
    'ai-office open',
  );
  await page.goto(await openOffice(office().home)).catch(() => {
    throw new Error('Fresh login navigation failed');
  });
  await expect(page.getByTestId('home-link')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(page.url()).not.toContain('code=');
  expect(
    (await page.request.get(office().url + '/api/v1/health')).status(),
  ).toBe(200);
});
