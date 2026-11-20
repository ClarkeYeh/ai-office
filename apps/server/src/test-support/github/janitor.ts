import { GithubApi, type JsonObject } from './api.js';
import {
  Ledger,
  leftovers,
  validateResource,
  type Resource,
  type ResourceLedger,
} from './ledger.js';
import { LABEL, hasHarnessMarker } from './safety.js';

export async function scan(
  api: GithubApi,
  ledger?: Pick<ResourceLedger, 'claims' | 'commands'>,
): Promise<{ openObjects: number[]; branches: string[] }> {
  const objects = await api.list('/issues?state=open');
  const branches = await api.list('/git/matching-refs/heads/ai-office/');
  const candidates = objects
    .filter((o) => {
      const commands = [
        ...String(o.body).matchAll(
          /<!-- (?:ai-office:cmd|aio-test:owner)=([a-zA-Z0-9:_/-]+) -->/g,
        ),
      ].map((m) => m[1]!);
      return commands.some(
        (command) =>
          /^t[a-f0-9]{12}[:-]/.test(command) ||
          ledger?.commands.includes(command) ||
          ledger?.claims.some(
            (claim) =>
              command.startsWith(claim + ':') ||
              command.startsWith(claim + '-'),
          ),
      );
    })
    .map((o) => Number(o.number));
  const openObjects: number[] = [];
  for (const number of candidates) {
    const current = await api.request('GET', `/issues/${number}`);
    if (current.status !== 404 && current.data.state !== 'closed')
      openObjects.push(number);
  }
  return {
    openObjects,
    branches: branches
      .map((b) => String(b.ref).replace(/^refs\/heads\//, ''))
      .filter(
        (b) =>
          /^ai-office\/t[a-f0-9]{12}(?:[-/]|$)/.test(b) ||
          ledger?.claims.some(
            (claim) =>
              b.startsWith(`ai-office/${claim}-`) ||
              b.startsWith(`ai-office/${claim}/`),
          ),
      ),
  };
}
const owns = (r: Resource, o: JsonObject) =>
  typeof o.body === 'string' &&
  hasHarnessMarker(o.body, r.key) &&
  (o.user as { login?: string } | undefined)?.login === 'ClarkeYeh' &&
  o.number !== 3;

/** No deletion by prefix alone: every mutation requires a validated ledger entry. */
export async function cleanup(
  ledger: Ledger,
  api: GithubApi,
  options: {
    apply?: boolean;
    deleteLocal?: (branch: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  for (const kind of [
    'pr',
    'issue',
    'comment',
    'branch',
    'localBranch',
    'status',
  ] as const) {
    for (const r of ledger.data.resources.filter(
      (r) => r.kind === kind && r.state !== 'done',
    )) {
      validateResource(ledger.data, r);
      if (kind === 'status') {
        if (options.apply) await ledger.done(r);
        continue;
      }
      if (kind === 'localBranch') {
        if (options.apply) {
          if (!options.deleteLocal)
            throw new Error('Local branch cleanup requires its pusher');
          await options.deleteLocal(r.key);
          await ledger.done(r);
        }
        continue;
      }
      if (kind === 'branch') {
        const path = `/branches/${encodeURIComponent(r.key)}`;
        const found = await api.request('GET', path);
        if (found.status !== 404 && found.data.protected !== false)
          throw new Error('Refusing protected or unknown branch');
        if (options.apply) {
          if (found.status !== 404)
            await api.request(
              'DELETE',
              `/git/refs/heads/${encodeURIComponent(r.key)}`,
            );
          if ((await api.request('GET', path)).status !== 404)
            throw new Error('Branch deletion not verified');
          await ledger.done(r);
        }
        continue;
      }
      const path =
        kind === 'pr'
          ? '/pulls'
          : kind === 'issue'
            ? '/issues'
            : '/issues/comments';
      let discovered = false;
      const handled = new Set<number>();
      // Do not mark a known resource done until a second inventory has had time
      // to reveal neighbouring duplicates (observed GitHub list lag: 4–9 s).
      for (let pass = 0; pass < (options.apply ? 2 : 1); pass++) {
        if (pass)
          await (
            options.sleep ??
            ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(15_000);
        // Recover all matches, including duplicates after a lost create response.
        const objects = await api.list(
          `${path}${kind === 'comment' ? '' : '?state=all'}`,
        );
        const matches = objects.filter(
          (o) => owns(r, o) && (kind !== 'issue' || !o.pull_request),
        );
        if (
          r.number &&
          !matches.some(
            (o) => Number(kind === 'comment' ? o.id : o.number) === r.number,
          )
        ) {
          const known = await api.request('GET', `${path}/${r.number}`);
          if (known.status !== 404 && !owns(r, known.data))
            throw new Error('Ledger object marker or owner mismatch');
          if (known.status !== 404) matches.push(known.data);
        }
        if (matches.length) discovered = true;
        for (const o of matches) {
          const number = Number(kind === 'comment' ? o.id : o.number);
          if (!Number.isSafeInteger(number) || number <= 0 || number === 3)
            throw new Error('Invalid cleanup object');
          if (!options.apply || handled.has(number)) continue;
          const fresh = await api.request('GET', `${path}/${number}`);
          if (fresh.status === 404) {
            handled.add(number);
            continue;
          }
          if (!owns(r, fresh.data))
            throw new Error('Ledger object marker or owner mismatch');
          if (kind === 'comment') {
            await api.request('DELETE', `${path}/${number}`);
            if ((await api.request('GET', `${path}/${number}`)).status !== 404)
              throw new Error('Comment deletion not verified');
          } else {
            if (kind === 'issue')
              await api.request('POST', `/issues/${number}/labels`, {
                labels: [LABEL],
              });
            if (fresh.data.state === 'open')
              await api.request('PATCH', `${path}/${number}`, {
                state: 'closed',
              });
            const verified = await api.request('GET', `${path}/${number}`);
            if (verified.status !== 404 && verified.data.state !== 'closed')
              throw new Error('Closure not verified');
          }
          handled.add(number);
        }
      }
      // A pending POST may remain invisible beyond the bounded observation window.
      if (options.apply && (discovered || r.state !== 'intent'))
        await ledger.done(r);
    }
  }
  return {
    leftovers: leftovers(ledger.data).length,
    scan: await scan(api, ledger.data),
  };
}
