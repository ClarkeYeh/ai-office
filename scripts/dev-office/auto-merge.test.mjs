import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherSession, autoMergeFinal } from './auto-merge.mjs';

test('launcher authentication preserves the browser bootstrap', async () => {
  const { startServer } = await import('../../apps/server/dist/main.js');
  const home = await mkdtemp(join(tmpdir(), 'aio-launcher-'));
  const server = await startServer({
    dev: true,
    fake: 'mainline',
    port: 0,
    env: { AI_OFFICE_HOME: home },
    webDist: join(home, 'no-web'),
    print: () => {},
  });
  try {
    assert.notEqual(server.port, 4319);
    const cookie = await launcherSession(home, server.url);
    assert.equal(
      (
        await globalThis.fetch(server.url + '/api/v1/gates', {
          headers: { cookie },
        })
      ).status,
      200,
    );
    const browser = await globalThis.fetch(server.bootstrapUrl, {
      redirect: 'manual',
    });
    assert.equal(browser.status, 302);
    assert.ok(browser.headers.get('set-cookie'));
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('auto merge uses the authenticated final-PR route and aborts cleanly', async (t) => {
  const abort = new globalThis.AbortController();
  /** @type {Array<{url: string, init: RequestInit}>} */
  const calls = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      calls.push({ url, init });
      if (String(url).includes('/gates?'))
        return globalThis.Response.json({
          gates: [
            {
              gateId: 'gate',
              workflowId: 'wf',
              version: 1,
              stageKind: 'final-pr',
              status: 'open',
            },
          ],
        });
      if (String(url).includes('/workflows/'))
        return globalThis.Response.json({
          readModel: { gates: [{ gateId: 'gate', pr: { number: 7 } }] },
        });
      abort.abort();
      return globalThis.Response.json({ mergeCommitSha: 'abc' });
    },
  );
  await assert.rejects(
    autoMergeFinal(
      'http://127.0.0.1:1234',
      'aio_session=test',
      0,
      abort.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 3);
  assert.ok(calls[2]);
  assert.equal(
    calls[2].url,
    'http://127.0.0.1:1234/dev/fake/scm/merge-final-pr',
  );
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { number: 7 });
  assert.equal(
    new globalThis.Headers(calls[2].init.headers).get('origin'),
    'http://127.0.0.1:1234',
  );
});
