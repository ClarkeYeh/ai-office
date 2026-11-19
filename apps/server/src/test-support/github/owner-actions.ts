import type { GithubApi } from './api.js';
import { assertRunId, marker, ownerMarker } from './safety.js';

/** What the owner does or sees on GitHub during the T15 mixed acceptance. */
export interface OwnerActions {
  issue(number: number): Promise<{
    body: string;
    labels: string[];
    state: 'open' | 'closed';
  }>;
  comments(number: number): Promise<{ body: string; author: string }[]>;
  pr(number: number): Promise<{
    body: string;
    state: 'open' | 'closed' | 'merged';
  }>;
  /** Issue numbers whose body carries this exact command marker (open or closed). */
  issuesWithMarker(commandId: string): Promise<number[]>;
  editIssueBody(number: number, body: string): Promise<void>;
  /** An owner-created Issue without an `ai-office:cmd` marker (§12.3 unknown object). */
  createUnmarkedIssue(purpose: string): Promise<number>;
  /** An owner comment without an `ai-office:cmd` marker (E13 `/approve`). */
  ownerComment(number: number, purpose: string, text: string): Promise<void>;
  setPrState(number: number, state: 'open' | 'closed'): Promise<void>;
}

type Row = Record<string, unknown>;
const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels)
    ? labels
        .map((l) => (typeof l === 'string' ? l : (l as { name?: string }).name))
        .filter((l): l is string => typeof l === 'string')
        .sort()
    : [];

/** Live owner actions over the guarded T7 transport (`harness.api`). */
export function githubOwnerActions(
  api: GithubApi,
  runId: string,
): OwnerActions {
  assertRunId(runId);
  const command = (purpose: string) => `t${runId}:owner-${purpose}`;
  const get = async (path: string) => {
    const { status, data } = await api.request('GET', path);
    if (status === 404) throw new Error('GitHub object not found');
    return data;
  };
  return {
    async issue(number) {
      const data = await get(`/issues/${number}`);
      return {
        body: String(data.body ?? ''),
        labels: labelNames(data.labels),
        state: data.state === 'closed' ? 'closed' : 'open',
      };
    },
    async comments(number) {
      return (await api.list(`/issues/${number}/comments`)).map((c: Row) => ({
        body: String(c.body ?? ''),
        author: String((c.user as Row | undefined)?.login ?? ''),
      }));
    },
    async pr(number) {
      const data = await get(`/pulls/${number}`);
      return {
        body: String(data.body ?? ''),
        state: data.merged_at
          ? 'merged'
          : data.state === 'closed'
            ? 'closed'
            : 'open',
      };
    },
    async issuesWithMarker(commandId) {
      const exact = marker(commandId);
      return (await api.list('/issues?state=all&sort=created&direction=desc'))
        .filter((r) => !r.pull_request && String(r.body ?? '').includes(exact))
        .map((r) => Number(r.number))
        .sort((a, b) => a - b);
    },
    async editIssueBody(number, body) {
      await api.request('PATCH', `/issues/${number}`, { body });
    },
    async createUnmarkedIssue(purpose) {
      const { data } = await api.request('POST', '/issues', {
        title: `[aio-test ${runId}] owner-created ${purpose}`,
        body: `Created by hand on GitHub (synthetic T15 check).\n\n${ownerMarker(command(purpose))}`,
      });
      return Number(data.number);
    },
    async ownerComment(number, purpose, text) {
      await api.request('POST', `/issues/${number}/comments`, {
        body: `${text}\n\n${ownerMarker(command(purpose))}`,
      });
    },
    async setPrState(number, state) {
      await api.request('PATCH', `/pulls/${number}`, { state });
    },
  };
}
