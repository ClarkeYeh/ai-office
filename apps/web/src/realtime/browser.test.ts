import { afterEach, expect, test, vi } from 'vitest';
import { createApiClient } from '../api/index.js';
import { createBrowserRealtime } from './browser.js';

afterEach(() => vi.unstubAllGlobals());

test('wires the native EventSource and the module replay worker', async () => {
  const sources: string[] = [];
  const workers: [URL, WorkerOptions | undefined][] = [];
  vi.stubGlobal(
    'EventSource',
    class {
      readyState = 0;
      onopen = null;
      onerror = null;
      constructor(url: string) {
        sources.push(url);
      }
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    'Worker',
    class {
      onmessage = null;
      constructor(url: URL, options?: WorkerOptions) {
        workers.push([url, options]);
      }
      postMessage() {}
      terminate() {}
    },
  );
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const body = path.includes('/workflows/wf1/events')
      ? { events: [] }
      : path.includes('/workflows')
        ? { workflows: [] }
        : path.includes('/gates')
          ? { gates: [] }
          : path.includes('/questions')
            ? { questions: [] }
            : path.includes('/repos')
              ? { repos: [] }
              : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const realtime = createBrowserRealtime(
    createApiClient({ fetch: fetch as typeof globalThis.fetch }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await realtime.start().catch(() => {});
  expect(sources).toEqual(['/api/v1/stream?afterSeq=0']);
  await realtime.replay.open('wf1').catch(() => {});
  expect(workers).toHaveLength(1);
  expect(String(workers[0]![0])).toMatch(/replay\.worker\.ts$/);
  expect(workers[0]![1]).toEqual({ type: 'module' });
  realtime.stop();
});
