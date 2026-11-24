import { describe, expect, it } from 'vitest';
import { githubRehearsalFacts, type FactsApi } from './github-facts.js';

const RUN = '0123456789ab';
const sha = (c: string) => c.repeat(40);
const marker = (id: string) => `body\n<!-- ai-office:cmd=${id} -->`;

function api(): FactsApi & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async list(path) {
      paths.push(path);
      return [
        { number: 1, body: marker(`t${RUN}:c1`) },
        { number: 2, body: marker(`t${RUN}:c1`), pull_request: {} },
        { number: 3, body: marker(`t${RUN}:c2`) },
        { number: 4, body: marker(`t${RUN}:c2`) },
        { number: 5, body: marker('tffffffffffff:c9') },
        { number: 6, body: null },
      ];
    },
    async request(_method, path) {
      paths.push(path);
      return {
        status: 200,
        data: {
          commits: [
            { sha: sha('1'), parents: [{ sha: sha('0') }] },
            { sha: sha('h'), parents: [{ sha: sha('1') }] },
            { sha: sha('2'), parents: [{ sha: sha('1') }, { sha: sha('h') }] },
            { sha: sha('3'), parents: [{ sha: sha('2') }, { sha: sha('x') }] },
          ],
        },
      };
    },
  };
}

describe('live rehearsal GitHub facts (read-only)', () => {
  it('counts Issues by marker (PRs excluded) since the run started', async () => {
    const a = api();
    const facts = githubRehearsalFacts(a, RUN, '2026-11-24T00:00:00.000Z');
    expect(await facts.issuesWithMarker(`t${RUN}:c1`)).toBe(1);
    expect(await facts.issuesWithMarker(`t${RUN}:c2`)).toBe(2);
    expect(a.paths[0]).toBe(
      '/issues?state=all&since=2026-11-24T00%3A00%3A00.000Z',
    );
  });

  it("takes the run's highest marker count across Issues and PRs", async () => {
    expect(
      await githubRehearsalFacts(api(), RUN, 'x').maxObjectsPerMarker(),
    ).toBe(2);
  });

  it('counts merge commits of a head and walks first parents from one compare', async () => {
    const a = api();
    const facts = githubRehearsalFacts(a, RUN, 'x');
    expect(await facts.mergesOf('ai-office/tx/integration', sha('h'))).toBe(1);
    expect(a.paths.at(-1)).toBe('/compare/main...ai-office/tx/integration');
    expect(
      await facts.firstParents('ai-office/tx/integration', sha('2')),
    ).toEqual([sha('2'), sha('3')]);
    expect(await facts.firstParents('b', sha('9'))).toEqual([]);
  });
});
