import { API, ROOT, marker } from './safety.js';

/** Namespace the shared suite's fixed command IDs at the HTTP boundary.
 * The adapter still sees the exact suite marker. Remote objects always carry
 * the run marker checked by the ledger. Only this run's collection rows enter
 * the recording; pagination and conditional headers are left intact.
 */
export function contractTransport(
  transport: typeof fetch,
  runId: string,
): typeof fetch {
  const prefix = `t${runId}:`;
  const map = (value: unknown, outgoing: boolean): unknown => {
    if (typeof value === 'string')
      return outgoing
        ? value.replace(/<!-- ai-office:cmd=([^> ]+) -->/g, (_, id: string) =>
            marker(prefix + id),
          )
        : value.replaceAll(
            `<!-- ai-office:cmd=${prefix}`,
            '<!-- ai-office:cmd=',
          );
    if (Array.isArray(value)) return value.map((v) => map(v, outgoing));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          k === 'title' && typeof v === 'string'
            ? outgoing
              ? `[aio-test ${runId}] ${v}`
              : v.replace(`[aio-test ${runId}] `, '')
            : map(v, outgoing),
        ]),
      );
    return value;
  };
  return async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    const response = await transport(
      new Request(
        request,
        body ? { body: JSON.stringify(map(JSON.parse(body), true)) } : {},
      ),
    );
    if ([204, 205, 304].includes(response.status)) return response;
    const data: unknown = await response.json();
    const path = new URL(request.url).pathname;
    let scoped = data;
    if (Array.isArray(data) && /\/(issues|pulls)(\/comments)?$/.test(path)) {
      scoped = data.filter((row: { body?: string }) =>
        row.body?.includes(`<!-- ai-office:cmd=${prefix}`),
      );
    } else if (
      Array.isArray(data) &&
      path.startsWith(`${ROOT}/git/matching-refs/`)
    ) {
      scoped = data.filter((row: { ref?: string }) =>
        row.ref?.startsWith(`refs/heads/ai-office/t${runId}-`),
      );
    }
    return new Response(JSON.stringify(map(scoped, false)), {
      status: response.status,
      headers: response.headers,
    });
  };
}

export const contractRepo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
export const contractUrl = API + ROOT;
