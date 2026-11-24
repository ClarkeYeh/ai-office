import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RecordingFetch } from './recording.js';
import { TapeLeakError } from './tape-normalization.js';
import { API, ROOT } from './safety.js';

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
