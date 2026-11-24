/**
 * M5-T11 read-only GitHub facts for the live rehearsal (GA level): marker
 * counts from the Issues API (since the run started, so earlier spike history
 * is never paged), merge commits and first parents from one compare call
 * (`main...<integration branch>`). Counts and SHAs only.
 */
import type { RehearsalBinding } from './run.js';

type Row = Record<string, unknown>;
export interface FactsApi {
  request(
    method: string,
    path: string,
  ): Promise<{ status: number; data: unknown }>;
  list(path: string): Promise<Row[]>;
}

type Commit = { sha: string; parents?: { sha: string }[] };
const markerOf = (body: unknown) =>
  /<!-- ai-office:cmd=([a-zA-Z0-9:_/-]+) -->/.exec(String(body ?? ''))?.[1];
const branchPath = (branch: string) =>
  branch.split('/').map(encodeURIComponent).join('/');

export function githubRehearsalFacts(
  api: FactsApi,
  runId: string,
  since: string,
): Pick<
  RehearsalBinding,
  'issuesWithMarker' | 'mergesOf' | 'maxObjectsPerMarker' | 'firstParents'
> {
  const rows = () =>
    api.list(`/issues?state=all&since=${encodeURIComponent(since)}`);
  const commits = async (branch: string): Promise<Commit[]> => {
    const { status, data } = await api.request(
      'GET',
      `/compare/main...${branchPath(branch)}`,
    );
    if (status !== 200) throw new Error(`compare ${status}`);
    return ((data as { commits?: Commit[] }).commits ?? []).filter(
      (c) => typeof c.sha === 'string',
    );
  };
  return {
    async issuesWithMarker(id) {
      return (await rows()).filter(
        (r) => r.pull_request === undefined && markerOf(r.body) === id,
      ).length;
    },
    async mergesOf(branch, head) {
      return (await commits(branch)).filter((c) => c.parents?.[1]?.sha === head)
        .length;
    },
    async maxObjectsPerMarker() {
      const counts = new Map<string, number>();
      for (const r of await rows()) {
        const id = markerOf(r.body);
        if (id?.startsWith(`t${runId}:`))
          counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return Math.max(0, ...counts.values());
    },
    async firstParents(branch, first) {
      const list = await commits(branch);
      const parents = new Map(list.map((c) => [c.sha, c.parents ?? []]));
      const chain: string[] = [];
      let sha = list.at(-1)?.sha;
      for (let i = 0; sha && parents.has(sha) && i < 250; i++) {
        chain.unshift(sha);
        if (sha === first) return chain;
        sha = parents.get(sha)?.[0]?.sha;
      }
      return [];
    },
  };
}
