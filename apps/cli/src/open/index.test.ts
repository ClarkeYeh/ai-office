import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { open } from './index.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function setup(pid = process.pid) {
  const home = mkdtempSync('/tmp/aio-open-');
  homes.push(home);
  mkdirSync(`${home}/data`);
  writeFileSync(
    `${home}/runtime.json`,
    JSON.stringify({ pid, port: 4321, startedAt: '2026-11-01T00:00:00Z' }),
  );
  writeFileSync(`${home}/data/control.token`, 'aio_ctl_' + 'f'.repeat(64));
  return home;
}
const success = () =>
  new Response(
    JSON.stringify({ code: 'example-code', expiresAt: '2026-11-24T00:01:00Z' }),
  );

test('print returns only a URL and authenticates via Bearer without browser cookies', async () => {
  const home = setup();
  const request = vi.fn<typeof fetch>().mockResolvedValue(success());
  const browser = vi.fn();
  const result = await open(['--home', home, '--print'], {
    fetch: request,
    openBrowser: browser,
  });
  expect(result).toEqual({
    exitCode: 0,
    message: 'http://127.0.0.1:4321/auth/bootstrap?code=example-code',
  });
  expect(request).toHaveBeenCalledWith(
    'http://127.0.0.1:4321/local/v1/bootstrap-codes',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer aio_ctl_' + 'f'.repeat(64) },
    }),
  );
  expect(browser).not.toHaveBeenCalled();
});
test('opens the verified URL by default, while --no-open suppresses it', async () => {
  const home = setup();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => success());
  const browser = vi.fn();
  expect(
    (
      await open([], {
        env: { AI_OFFICE_HOME: home },
        fetch: request,
        openBrowser: browser,
      })
    ).exitCode,
  ).toBe(0);
  expect(browser).toHaveBeenCalledTimes(1);
  await open(['--home', home, '--no-open'], {
    fetch: request,
    openBrowser: browser,
  });
  expect(browser).toHaveBeenCalledTimes(1);
});
test('a reused live pid with failed endpoint authentication is not AI Office', async () => {
  const home = setup();
  const browser = vi.fn();
  const result = await open(['--home', home], {
    fetch: vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 })),
    openBrowser: browser,
  });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain('ai-office start');
  expect(browser).not.toHaveBeenCalled();
});
test.each([
  ['--home', '/nonexistent/aio-home'],
  ['--home', 'relative'],
  ['--home'],
  ['--unknown'],
])('reports invalid or missing runtime: %j', async (...args) => {
  expect((await open(args)).exitCode).toBe(1);
});
test('a dead pid fails before reading token or calling the endpoint', async () => {
  const request = vi.fn<typeof fetch>();
  expect(
    (await open(['--home', setup(2147483647)], { fetch: request })).exitCode,
  ).toBe(1);
  expect(request).not.toHaveBeenCalled();
});
