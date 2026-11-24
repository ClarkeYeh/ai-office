import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RecordingFetch, ReplayFetch, type Recording } from './recording.js';
import { TapeLeakError, assertTapeSafe } from './tape-normalization.js';
import { API, ROOT } from './safety.js';
import {
  nextPage,
  nextQuery,
} from '../../adapters/scm-github/http/pagination.js';

it('lets a harness wrapper replace withheld rows and persists no leaked bytes', async () => {
  const secret = 'private' + '@sensitive.test';
  let response = new Response(JSON.stringify({ email: secret }));
  const recorder = new RecordingFetch(async () => response);
  const request = new Request(API + ROOT + '/issues');
  let leak: unknown;
  try {
    await recorder.capture(request);
  } catch (error) {
    leak = error;
  }
  expect(leak).toBeInstanceOf(TapeLeakError);
  expect(Object.keys(leak as object)).not.toContain('response');
  expect(recorder.withheldResponses).toBe(1);
  recorder.acknowledge(leak);
  response = new Response(JSON.stringify({ withheld: 'tape leak scan' }));
  await recorder.capture(request);
  const dir = await mkdtemp(join(tmpdir(), 'aio-withheld-'));
  try {
    const path = join(dir, 'tape.json');
    await recorder.save(path);
    const bytes = await readFile(path, 'utf8');
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain('tape leak scan');
    expect(JSON.parse(bytes)).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('returns the original response and counts every withheld response', async () => {
  const recorder = new RecordingFetch(
    async () =>
      new Response(JSON.stringify({ email: 'private@sensitive.test' })),
  );
  for (let i = 0; i < 2; i++) {
    const response = await recorder.fetch(API + ROOT + '/issues');
    expect(await response.json()).toEqual({ email: 'private@sensitive.test' });
  }
  expect(recorder.withheldResponses).toBe(2);
  expect(recorder.recordings).toHaveLength(2);
  expect(JSON.stringify(recorder.recordings)).not.toContain(
    'private@sensitive.test',
  );
  expect(() => recorder.assertNoLeak()).toThrow(TapeLeakError);
});

const opaqueCursor = 'Y3Vyc29yOnYyOpK5NDcxOTI4MzUwNjc4OTAxMjM0NTY=';

it.each(['after', 'before'] as const)(
  'persists opaque %s cursors safely and follows their links in strict replay',
  async (key) => {
    const first = `${API}${ROOT}/issues?per_page=1`;
    const second = new URL(first);
    second.searchParams.set(key, opaqueCursor);
    const recorder = new RecordingFetch(async (input) =>
      Response.json([], {
        headers:
          new Request(input).url === first
            ? { link: `<${second}>; rel="next"` }
            : {},
      }),
    );
    await recorder.fetch(first);
    await recorder.fetch(second);
    // An uncommitted poll cursor can be reused in a later request.
    await recorder.fetch(second);
    assertTapeSafe(recorder.recordings);
    expect(recorder.recordings[1]!.query).toContainEqual([key, 'CURSOR_1']);
    expect(recorder.recordings[2]!.query).toEqual(
      recorder.recordings[1]!.query,
    );
    const dir = await mkdtemp(join(tmpdir(), 'aio-cursor-'));
    try {
      const path = join(dir, 'tape.json');
      await recorder.save(path);
      const bytes = await readFile(path, 'utf8');
      expect(bytes).not.toContain(opaqueCursor);
      const replay = new ReplayFetch(JSON.parse(bytes) as Recording[]);
      const response = await replay.fetch(first);
      const next = nextPage(response.headers.get('link'), new URL(first))!;
      const replayUrl = new URL(first);
      for (const [name, value] of Object.entries(nextQuery(next)))
        if (value !== undefined)
          replayUrl.searchParams.set(name, String(value));
      const wrong = new URL(replayUrl);
      wrong.searchParams.set(key, 'CURSOR_2');
      await expect(replay.fetch(wrong)).rejects.toThrow('mismatch');
      wrong.searchParams.set(key, opaqueCursor);
      await expect(replay.fetch(wrong)).rejects.toThrow('mismatch');
      await replay.fetch(replayUrl);
      await replay.fetch(replayUrl);
      replay.assertConsumed();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(['after', 'before', 'other'])(
  'refuses token and email query values under %s before replacing them',
  async (key) => {
    for (const secret of [
      'ghp_' + 'SyntheticSecret123456789',
      'private@sensitive.test',
    ]) {
      const recorder = new RecordingFetch(async () => Response.json([]));
      const url = new URL(API + ROOT + '/issues');
      url.searchParams.set(key, secret);
      await expect(recorder.fetch(url)).rejects.toThrow(TapeLeakError);
      expect(recorder.recordings).toEqual([]);
    }
  },
);

it('keeps high-entropy values outside recognized cursor fields as hard scan failures', async () => {
  const recorder = new RecordingFetch(async () => Response.json([]));
  const url = new URL(API + ROOT + '/issues');
  url.searchParams.set('other', opaqueCursor);
  await recorder.fetch(url);
  expect(() => assertTapeSafe(recorder.recordings)).toThrow(TapeLeakError);
});
