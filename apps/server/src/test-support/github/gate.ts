import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireLiveLock } from './lock.js';
import { API, REPO, assertOptIn, assertRepo } from './safety.js';
import { ghToken } from './process.js';

export type GateOptions = {
  env?: NodeJS.ProcessEnv;
  repo?: string;
  lockPath?: string;
  fetch?: typeof fetch;
  token?: (active: boolean) => Promise<string>;
};
export async function openGate(options: GateOptions = {}) {
  const env = options.env ?? process.env;
  assertOptIn(env);
  assertRepo(options.repo ?? REPO);
  const release = await acquireLiveLock(
    options.lockPath ??
      join(homedir(), '.ai-office/test-state/github-live.lock'),
  );
  const transport = options.fetch ?? globalThis.fetch;
  const readToken = options.token ?? ghToken;
  const calls: string[] = [];
  async function get(
    path: string,
    token: string,
  ): Promise<Record<string, unknown>> {
    calls.push(`GET ${path}`);
    let response: Response;
    try {
      response = await transport(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('GitHub safety probe failed');
    }
    if (!response.ok) throw new Error('GitHub safety probe refused');
    return (await response.json()) as Record<string, unknown>;
  }
  try {
    const token = await readToken(false);
    if ((await get('/user', token)).login !== 'ClarkeYeh')
      throw new Error('Selected account must be ClarkeYeh');
    if ((await get('/user', await readToken(true))).login !== 'ClarkeYeh')
      throw new Error(
        'Active account must be ClarkeYeh; ask the owner to switch',
      );
    const quota = await get('/rate_limit', token);
    const remaining = (
      quota.resources as { core?: { remaining?: number } } | undefined
    )?.core?.remaining;
    if (typeof remaining !== 'number' || remaining < 1500)
      throw new Error('GitHub core quota below 1500');
    const user = await get('/users/ClarkeYeh', token);
    if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0)
      throw new Error('Invalid GitHub user identity');
    const email = `${user.id}+ClarkeYeh@users.noreply.github.com`;
    if (env.AIO_TEST_GIT_EMAIL && env.AIO_TEST_GIT_EMAIL !== email)
      throw new Error('Configured noreply identity does not match GitHub');
    let closed = false;
    let lastWrite = 0;
    return {
      email,
      remaining,
      calls,
      async assertActive() {
        if (closed) throw new Error('GitHub gate closed');
        assertOptIn(env);
        if ((await get('/user', await readToken(true))).login !== 'ClarkeYeh')
          throw new Error('Active account must be ClarkeYeh');
      },
      fetch: (async (input, init) => {
        if (closed) throw new Error('GitHub gate closed');
        assertOptIn(env);
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (
          url.origin !== API ||
          url.username ||
          url.password ||
          url.hash ||
          (!(
            ['/user', '/rate_limit'].includes(url.pathname) &&
            request.method === 'GET'
          ) &&
            !(
              url.pathname === `/repos/${REPO}` ||
              url.pathname.startsWith(`/repos/${REPO}/`)
            ))
        )
          throw new Error('GitHub request outside spike');
        const headers = new Headers(request.headers);
        headers.set('Authorization', `Bearer ${token}`);
        headers.set('X-GitHub-Api-Version', '2022-11-28');
        if (request.method !== 'GET') {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, lastWrite + 1000 - Date.now())),
          );
          lastWrite = Date.now();
        }
        calls.push(`${request.method} ${url.pathname}`);
        try {
          return await transport(
            new Request(request, {
              headers,
              redirect: 'error',
              signal: AbortSignal.timeout(30_000),
            }),
          );
        } catch {
          throw new Error('GitHub transport failed');
        }
      }) as typeof fetch,
      async close() {
        closed = true;
        await release();
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
