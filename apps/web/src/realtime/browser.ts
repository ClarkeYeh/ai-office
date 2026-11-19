import type { ApiClient } from '../api/index.js';
import { createRealtime, type Realtime } from './realtime.js';

/** Production wiring: native EventSource and the module replay worker. */
export function createBrowserRealtime(api: ApiClient): Realtime {
  return createRealtime({
    api,
    openEventSource: (url) => new EventSource(url),
    createWorker: () =>
      new Worker(new URL('./replay.worker.ts', import.meta.url), {
        type: 'module',
      }),
  });
}
