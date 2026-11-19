import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { RepoScmRef } from '../../../ports/refs.js';
import {
  CREATE_PENDING_WINDOW_MS,
  MARKER_SCAN_SLACK_MS,
  type MarkerMatch,
  type ScmPort,
} from '../../../ports/scm.js';
import { unavailable } from '../errors.js';
import { guard } from '../policy/endpoints.js';
import { repoParams, type ScmGithubDeps } from './deps.js';

export function commandMarker(commandId: string): string {
  if (!commandId || /[\s<>]/.test(commandId)) guard('invalid_command_marker');
  return `<!-- ai-office:cmd=${commandId} -->`;
}
/**
 * Append the command marker once. Engine bodies already carry it, so the body
 * on GitHub stays byte-identical to the recorded command args and its
 * `bodyHash` matches the gate's `renderedHash`.
 */
export function markedBody(body: string, commandId: string): string {
  const marker = commandMarker(commandId);
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
}
const actor = z.looseObject({ login: z.string() });
const markedIssue = z.looseObject({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
  user: actor,
  pull_request: z.looseObject({}).optional(),
});
const markedComment = z.looseObject({
  id: z.number().int().positive().safe(),
  html_url: z.string().url(),
  issue_url: z.string().url(),
  body: z.string().nullable(),
  user: actor,
});
export function createMarkerMethods(
  deps: ScmGithubDeps,
): Pick<ScmPort, 'findByMarker'> {
  return {
    async findByMarker(repo, commandId, hint = {}) {
      const marker = commandMarker(commandId);
      const viewer = await deps.viewerLogin();
      const timestamp = Date.parse(
        hint.since ?? deps.registeredAt?.(repo) ?? '1970-01-01T00:00:00Z',
      );
      if (!Number.isFinite(timestamp)) guard('invalid_marker_since');
      const since = new Date(
        Math.max(0, timestamp - MARKER_SCAN_SLACK_MS),
      ).toISOString();
      const matches: MarkerMatch[] = [];
      if (hint.kind !== 'comment') {
        const issues = await deps.http.paginate(
          'issues.list',
          {
            ...repoParams(repo),
            query: {
              state: 'all',
              creator: viewer,
              since,
              sort: 'created',
              direction: 'asc',
              per_page: 100,
            },
          },
          { schema: z.array(markedIssue), conditional: false },
        );
        for (const issue of issues) {
          const kind = issue.pull_request ? 'pr' : 'issue';
          if (
            issue.user.login === viewer &&
            issue.body?.includes(marker) &&
            (!hint.kind || kind === hint.kind)
          )
            matches.push({
              repo,
              number: issue.number,
              kind,
              url: issue.html_url,
            });
        }
      }
      if (!hint.kind || hint.kind === 'comment') {
        const comments = await deps.http.paginate(
          'comments.list',
          {
            ...repoParams(repo),
            query: { since, per_page: 100 },
          },
          { schema: z.array(markedComment), conditional: false },
        );
        for (const comment of comments) {
          if (comment.user.login !== viewer || !comment.body?.includes(marker))
            continue;
          const url = new URL(comment.issue_url);
          const prefix = `/repos/${repo.owner}/${repo.name}/issues/`;
          const number = Number(url.pathname.slice(prefix.length));
          if (
            url.origin !== 'https://api.github.com' ||
            !url.pathname.startsWith(prefix) ||
            !Number.isSafeInteger(number) ||
            number <= 0
          )
            throw new PortError(
              'contract_mismatch',
              'github_contract_mismatch',
              'Invalid comment issue reference',
            );
          matches.push({
            repo,
            number,
            kind: 'comment',
            commentId: String(comment.id),
            url: comment.html_url,
          });
        }
      }
      matches.sort(
        (a, b) =>
          Number(a.commentId ?? a.number) - Number(b.commentId ?? b.number),
      );
      const keeper = matches[0];
      return keeper
        ? {
            ...keeper,
            ...(matches.length > 1 ? { duplicates: matches.length - 1 } : {}),
          }
        : null;
    },
  };
}

/** Serialize concurrent attempts of one command; ambiguous outcomes wait for visibility. */
export function createPendingOperation(deps: ScmGithubDeps) {
  const pending = new Map<string, { since: number; uncertainAt: number }>();
  const inFlight = new Map<string, Promise<MarkerMatch>>();
  const completed = new Map<string, MarkerMatch>();
  const { findByMarker } = createMarkerMethods(deps);
  return (
    repo: RepoScmRef,
    commandId: string,
    kind: 'issue' | 'comment',
    create: () => Promise<MarkerMatch>,
  ): Promise<MarkerMatch> => {
    const key = JSON.stringify([
      repo.owner.toLowerCase(),
      repo.name.toLowerCase(),
      kind,
      commandId,
    ]);
    deps.repoAllowlist.assert(repo, true);
    commandMarker(commandId);
    const done = completed.get(key);
    if (done) return Promise.resolve(done);
    const active = inFlight.get(key);
    if (active) return active;
    const attempt = async () => {
      const previous = pending.get(key);
      if (previous !== undefined) {
        const found = await findByMarker(repo, commandId, {
          kind,
          since: new Date(previous.since).toISOString(),
        });
        if (found) return found;
        if (deps.clock() - previous.uncertainAt < CREATE_PENDING_WINDOW_MS)
          throw unavailable(true);
      }
      const sentAt = deps.clock();
      try {
        return await create();
      } catch (error) {
        if (
          error instanceof PortError &&
          error.code === 'create_outcome_unknown'
        )
          // The transport may have queued this write behind its governor.
          // Starting the wait on failure conservatively preserves the entire
          // visibility window, while scans still include the first attempt.
          pending.set(key, {
            since: previous?.since ?? sentAt,
            uncertainAt: deps.clock(),
          });
        throw error;
      }
    };
    const promise = attempt()
      .then((result) => {
        pending.delete(key);
        completed.set(key, result);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}
