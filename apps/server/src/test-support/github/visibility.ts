import { GithubApi, type JsonObject } from './api.js';
import { ROOT } from './safety.js';
export const VISIBILITY_TIMEOUT_MS = 30_000;
type Timing = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
};
const realTiming: Timing = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
export async function waitForVisibility(
  check: () => Promise<boolean>,
  timing: Timing = realTiming,
): Promise<void> {
  const deadline = timing.now() + (timing.timeoutMs ?? VISIBILITY_TIMEOUT_MS);
  for (;;) {
    if (await check()) return;
    if (timing.now() >= deadline)
      throw new Error('GitHub visibility did not settle');
    await timing.sleep(Math.min(1000, deadline - timing.now()));
  }
}
/** Wait for real collection visibility before returning writes to the shared suite.
 * These are harness probes, logged by the gate, not synthetic adapter responses.
 * Recording and injected loss/lag sit outside this boundary.
 */
export function visibleWrites(
  transport: typeof fetch,
  timing: Timing = realTiming,
): typeof fetch {
  const api = new GithubApi(transport);
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await transport(request);
    if (!response.ok || request.method === 'GET') return response;
    const path = decodeURIComponent(
      new URL(request.url).pathname.slice(ROOT.length),
    );
    if (
      /^\/(issues|pulls)(?:\/\d+)?$/.test(path) ||
      /^\/issues\/\d+\/comments$/.test(path)
    ) {
      const created = (await response.clone().json()) as JsonObject;
      const comment = path.endsWith('/comments');
      const collection = comment
        ? '/issues/comments'
        : path.startsWith('/pulls')
          ? '/pulls?state=all&sort=updated&direction=desc'
          : '/issues?state=all&sort=updated&direction=desc';
      await waitForVisibility(async () => {
        const rows = await api.list(collection);
        return rows.some(
          (r) =>
            (comment ? r.id === created.id : r.number === created.number) &&
            r.body === created.body &&
            (comment || r.state === created.state),
        );
      }, timing);
      if (path === '/pulls')
        await waitForVisibility(
          async () =>
            (await api.list('/issues?state=all')).some(
              (r) => r.number === created.number,
            ),
          timing,
        );
    } else if (
      path.startsWith('/git/refs/heads/') &&
      request.method === 'DELETE'
    ) {
      const branch = path.slice('/git/refs/heads/'.length);
      await waitForVisibility(async () => {
        const prs = await api.list('/pulls?state=all');
        for (const pr of prs) {
          if ((pr.head as { ref?: string })?.ref !== branch) continue;
          if (pr.state === 'open') return false;
          if (
            (await api.request('GET', `/pulls/${Number(pr.number)}`)).data
              .state === 'open'
          )
            return false;
        }
        return true;
      }, timing);
    }
    return response;
  };
}
