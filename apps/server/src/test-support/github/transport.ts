import { GithubApi, type JsonObject } from './api.js';
import { Ledger, type Resource } from './ledger.js';
import { API, ROOT, assertBranch, assertCommand, marker } from './safety.js';

/** Serial transport with intent-before-create, repository and object ownership guards. */
export function guardedFetch(
  transport: typeof fetch,
  ledger: Ledger,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): typeof fetch {
  const api = new GithubApi(transport);
  let tail: Promise<unknown> = Promise.resolve();
  let lastWrite = 0;
  const creates: number[] = [];
  async function owned(kind: string, number: number): Promise<JsonObject> {
    const resource = ledger.data.resources.find(
      (r) =>
        (r.kind === kind || (kind === 'issue' && r.kind === 'pr')) &&
        r.number === number,
    );
    if (!resource || number === 3) throw new Error('Object not in this ledger');
    const path =
      kind === 'comment'
        ? '/issues/comments'
        : kind === 'pr'
          ? '/pulls'
          : '/issues';
    const { data } = await api.request('GET', `${path}/${number}`);
    if (
      typeof data.body !== 'string' ||
      !data.body.includes(marker(resource.key)) ||
      (data.user as { login?: string } | undefined)?.login !== 'ClarkeYeh'
    )
      throw new Error('Object ownership mismatch');
    return data;
  }
  async function run(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      url.origin === API &&
      ['/user', '/rate_limit', ROOT].includes(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.hash
    )
      return transport(request);
    if (
      url.origin !== API ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith(ROOT + '/')
    )
      throw new Error('Request outside spike');
    const path = decodeURIComponent(url.pathname.slice(ROOT.length));
    if (path.includes('..') || path.includes('\\'))
      throw new Error('Unsafe API path');
    const method = request.method;
    if (method === 'GET') {
      if (
        !/^\/(?:issues(?:\/.*)?|pulls(?:\/.*)?|branches(?:\/.*)?|git\/(?:ref|matching-refs)\/heads\/.*|compare\/.*|commits\/.*|rules\/branches\/.*|labels(?:\/.*)?)$/.test(
          path,
        )
      )
        throw new Error('Read endpoint not allowed');
      return transport(request);
    }
    const body: JsonObject = request.body
      ? ((await request.clone().json()) as JsonObject)
      : {};
    if ('force' in body) throw new Error('Force is forbidden');
    let resource: Resource | undefined;
    let allowed = false;
    if (
      method === 'POST' &&
      (path === '/issues' ||
        path === '/pulls' ||
        /^\/issues\/\d+\/comments$/.test(path))
    ) {
      const command =
        typeof body.body === 'string'
          ? /<!-- ai-office:cmd=([a-zA-Z0-9:_/-]+) -->/.exec(body.body)?.[1]
          : undefined;
      if (!command) throw new Error('Create requires run marker');
      assertCommand(command, ledger.data.runId, ledger.data.claims);
      const kind =
        path === '/issues' ? 'issue' : path === '/pulls' ? 'pr' : 'comment';
      if (
        kind !== 'comment' &&
        (typeof body.title !== 'string' ||
          !body.title.startsWith(`[aio-test ${ledger.data.runId}] `))
      )
        throw new Error('Create requires run title');
      if (kind === 'comment') await owned('issue', Number(path.split('/')[2]));
      if (kind === 'pr') {
        assertBranch(String(body.head), ledger.data.runId, ledger.data.claims);
        if (body.base !== 'main')
          assertBranch(
            String(body.base),
            ledger.data.runId,
            ledger.data.claims,
          );
      }
      resource = await ledger.intent(kind, command);
      allowed = true;
    } else if (method === 'POST' && path === '/git/refs') {
      const branch = String(body.ref).replace(/^refs\/heads\//, '');
      assertBranch(branch, ledger.data.runId, ledger.data.claims);
      if (
        body.ref !== `refs/heads/${branch}` ||
        !/^[a-f0-9]{40}$/.test(String(body.sha))
      )
        throw new Error('Invalid branch request');
      const existing = await api.request(
        'GET',
        `/branches/${encodeURIComponent(branch)}`,
      );
      if (
        existing.status !== 404 &&
        !ledger.data.resources.some(
          (r) => r.kind === 'branch' && r.key === branch,
        )
      )
        throw new Error('Branch existed before this run');
      resource = await ledger.intent('branch', branch);
      allowed = true;
    } else if (method === 'DELETE' && path.startsWith('/git/refs/heads/')) {
      const branch = path.slice('/git/refs/heads/'.length);
      assertBranch(branch, ledger.data.runId, ledger.data.claims);
      if (
        !ledger.data.resources.some(
          (r) => r.kind === 'branch' && r.key === branch,
        )
      )
        throw new Error('Branch not in ledger');
      const found = await api.request(
        'GET',
        `/branches/${encodeURIComponent(branch)}`,
      );
      if (found.status !== 404 && found.data.protected !== false)
        throw new Error('Branch is protected');
      allowed = true;
    } else if (method === 'POST' && path === '/merges') {
      // S20: scm-github merges with an explicit base; only run-owned,
      // unprotected ai-office/ test bases (never the default branch).
      assertBranch(String(body.base), ledger.data.runId, ledger.data.claims);
      if (
        !/^[a-f0-9]{40}$/.test(String(body.head)) ||
        typeof body.commit_message !== 'string'
      )
        throw new Error('Merge requires pinned head');
      const target = await api.request(
        'GET',
        `/branches/${encodeURIComponent(String(body.base))}`,
      );
      if (target.data.protected !== false)
        throw new Error('Branch is protected');
      allowed = true;
    } else if (/^\/(issues|pulls)\/\d+(?:\/labels)?$/.test(path)) {
      const [, group, number, action] = path.split('/');
      const object = await owned(
        group === 'pulls' ? 'pr' : 'issue',
        Number(number),
      );
      if (action === 'labels' && ['POST', 'PUT'].includes(method)) {
        allowed =
          Array.isArray(body.labels) &&
          body.labels.every(
            (v) =>
              typeof v === 'string' &&
              /^(ai-office-test$|ai-office:|agent:|role:)/.test(v),
          );
      } else if (!action && method === 'PATCH') {
        allowed = Object.keys(body).every((k) =>
          ['title', 'body', 'state'].includes(k),
        );
        if (
          body.body !== undefined &&
          (typeof body.body !== 'string' ||
            !body.body.includes(
              String(object.body).match(/<!-- ai-office:cmd=[^>]+ -->/)?.[0] ??
                '\0',
            ))
        )
          allowed = false;
      }
    } else if (method === 'DELETE' && /^\/issues\/comments\/\d+$/.test(path)) {
      await owned('comment', Number(path.split('/').at(-1)));
      allowed = true;
    } else if (method === 'POST' && /^\/statuses\/[a-f0-9]{40}$/.test(path)) {
      const refs = await api.list('/git/matching-refs/heads/ai-office/');
      const sha = path.split('/').at(-1);
      if (
        !refs.some(
          (ref) =>
            (ref.object as { sha?: string })?.sha === sha &&
            ledger.data.resources.some(
              (r) => r.kind === 'branch' && ref.ref === 'refs/heads/' + r.key,
            ),
        )
      )
        throw new Error('Status SHA not owned by this run');
      if (
        !['pending', 'success', 'failure', 'error'].includes(String(body.state))
      )
        throw new Error('Invalid status');
      resource = await ledger.intent(
        'status',
        't' + ledger.data.runId + ':status-' + sha,
      );
      allowed = true;
    } else if (method === 'POST' && path === '/labels') {
      allowed =
        typeof body.name === 'string' &&
        /^(ai-office-test$|ai-office:|agent:|role:)/.test(body.name);
    }
    if (!allowed) throw new Error('Mutation endpoint or payload not allowed');
    await sleep(Math.max(0, lastWrite + 1000 - Date.now()));
    if (method === 'POST') {
      while (creates.length && creates[0]! < Date.now() - 60_000)
        creates.shift();
      if (creates.length >= 20)
        await sleep(Math.max(0, creates[0]! + 60_000 - Date.now()));
      creates.push(Date.now());
    }
    lastWrite = Date.now();
    const response = await transport(request);
    if (resource && response.ok) {
      const data = (await response.clone().json()) as JsonObject;
      const number = resource.kind === 'comment' ? data.id : data.number;
      if (
        !['branch', 'status'].includes(resource.kind) &&
        (!Number.isSafeInteger(number) || Number(number) <= 0)
      )
        throw new Error('Created resource response missing identity');
      await ledger.created(
        resource,
        typeof number === 'number' ? number : undefined,
      );
    }
    return response;
  }
  return ((input, init) => {
    const request = new Request(input, init);
    const promise = tail.then(() => run(request));
    tail = promise.catch(() => undefined);
    return promise;
  }) as typeof fetch;
}
