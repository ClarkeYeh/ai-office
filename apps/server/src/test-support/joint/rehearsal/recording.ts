/**
 * M5-T11 live transport wrapper (M3-T15 `scopedRecording` pattern): counts
 * every request (and the 304s) for the report, and records only segment 1,
 * from the start until the first kill. The adapter always gets GitHub's full
 * response; the tape keeps only this run's rows of collection responses, and a
 * response the tape leak scan rejects is recorded withheld and counted (T16:
 * never turned into a product error). Evidence only: never replayed call by
 * call (coordinator ruling, M3-T15).
 */
import { RecordingFetch } from '../../github/recording.js';
import { ROOT } from '../../github/safety.js';
import {
  TapeLeakError,
  assertTapeSafe,
} from '../../github/tape-normalization.js';

const NO_BODY = [204, 205, 304];

export function segmentRecording(
  transport: typeof globalThis.fetch,
  runId: string,
) {
  const mine = (body: unknown) =>
    typeof body === 'string' &&
    (body.includes(`<!-- ai-office:cmd=t${runId}:`) ||
      body.includes(`<!-- aio-test:owner=t${runId}:`));
  let next: Response | undefined;
  const recorder = new RecordingFetch(async () => next!, runId);
  let tail: Promise<unknown> = Promise.resolve();
  let recording = true;
  const counts = { requests: 0, notModified: 0, segment1: 0, withheld: 0 };
  const record = async (request: Request): Promise<Response> => {
    const full = await transport(request.clone());
    counts.requests++;
    if (full.status === 304) counts.notModified++;
    if (!recording) return full;
    counts.segment1++;
    const path = new URL(request.url).pathname;
    next = full.clone();
    if (!NO_BODY.includes(full.status)) {
      const data: unknown = await full
        .clone()
        .json()
        .catch(() => undefined);
      let scoped = data;
      if (Array.isArray(data) && /\/(issues|pulls)(\/comments)?$/.test(path))
        scoped = data.filter((row: { body?: unknown }) => mine(row.body));
      else if (
        Array.isArray(data) &&
        path.startsWith(`${ROOT}/git/matching-refs/`)
      )
        scoped = data.filter((row: { ref?: string }) =>
          row.ref?.startsWith(`refs/heads/ai-office/t${runId}`),
        );
      if (scoped !== data)
        next = new Response(JSON.stringify(scoped), {
          status: full.status,
          headers: full.headers,
        });
    }
    try {
      await recorder.capture(request);
    } catch (error) {
      if (!(error instanceof TapeLeakError)) throw error;
      recorder.acknowledge(error);
      counts.withheld++;
      next = new Response(
        NO_BODY.includes(full.status)
          ? null
          : JSON.stringify({ withheld: 'tape leak scan' }),
        { status: full.status },
      );
      await recorder.capture(request);
    }
    return full;
  };
  // Serialized like the M3 recorder: one capture at a time keeps tape order.
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (!recording) return record(request);
    const result = tail.then(() => record(request));
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    recorder,
    fetch,
    counts,
    /** Segment 1 ends at the first kill. */
    stop() {
      recording = false;
    },
    /** Concrete paths become templates; still-rejected responses are withheld. */
    sanitize() {
      for (const r of recorder.recordings) {
        r.path = r.pathTemplate;
        if (leaks(r)) {
          r.response = { withheld: 'tape leak scan' };
          r.headers = {};
        }
      }
    },
  };
}

function leaks(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      assertTapeSafe(value);
      return false;
    } catch {
      return true;
    }
  }
  if (Array.isArray(value)) return value.some(leaks);
  if (value && typeof value === 'object') return Object.values(value).some(leaks);
  return false;
}
