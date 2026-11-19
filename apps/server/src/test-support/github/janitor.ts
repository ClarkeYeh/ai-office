import { GithubApi, type JsonObject } from './api.js';
import {
  Ledger,
  leftovers,
  validateResource,
  type Resource,
  type ResourceLedger,
} from './ledger.js';
import { LABEL, marker } from './safety.js';

export async function scan(
  api: GithubApi,
  ledger?: Pick<ResourceLedger, 'claims' | 'commands'>,
): Promise<{ openObjects: number[]; branches: string[] }> {
  const objects = await api.list('/issues?state=open');
  const branches = await api.list('/git/matching-refs/heads/ai-office/');
  return {
    openObjects: objects
      .filter((o) => {
        const commands = [
          ...String(o.body).matchAll(
            /<!-- ai-office:cmd=([a-zA-Z0-9:_/-]+) -->/g,
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
      .map((o) => Number(o.number)),
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
  o.body.includes(marker(r.key)) &&
  (o.user as { login?: string } | undefined)?.login === 'ClarkeYeh' &&
  o.number !== 3;

/** No deletion by prefix alone: every mutation requires a validated ledger entry. */
export async function cleanup(
  ledger: Ledger,
  api: GithubApi,
  options: {
    apply?: boolean;
    deleteLocal?: (branch: string) => Promise<void>;
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
      // A pending POST may still become visible later. Never silently erase it.
      if (!matches.length && r.state === 'intent') continue;
      for (const o of matches) {
        const number = Number(kind === 'comment' ? o.id : o.number);
        if (!Number.isSafeInteger(number) || number <= 0 || number === 3)
          throw new Error('Invalid cleanup object');
        if (!options.apply) continue;
        if (kind === 'comment') {
          await api.request('DELETE', `${path}/${number}`);
          if ((await api.request('GET', `${path}/${number}`)).status !== 404)
            throw new Error('Comment deletion not verified');
        } else {
          if (kind === 'issue')
            await api.request('POST', `/issues/${number}/labels`, {
              labels: [LABEL],
            });
          if (o.state === 'open')
            await api.request('PATCH', `${path}/${number}`, {
              state: 'closed',
            });
          const verified = await api.request('GET', `${path}/${number}`);
          if (verified.status !== 404 && verified.data.state !== 'closed')
            throw new Error('Closure not verified');
        }
      }
      if (options.apply) await ledger.done(r);
    }
  }
  return {
    leftovers: leftovers(ledger.data).length,
    scan: await scan(api, ledger.data),
  };
}
