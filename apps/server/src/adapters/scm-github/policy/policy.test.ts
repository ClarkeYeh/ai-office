import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { endpoints, prepareRequest, type EndpointId } from './endpoints.js';
import { RepoAllowlist } from './repos.js';
const params = {
  owner: 'owner',
  repo: 'project',
  number: 1,
  id: 1,
  ref: 'ai-office/topic',
  branch: 'ai-office/topic',
  base: 'main',
  head: 'ai-office/topic',
  sha: 'a'.repeat(40),
};

describe('GitHub policy negative matrix', () => {
  it.each(
    Object.keys(endpoints).filter((id) =>
      endpoints[id as EndpointId].path.startsWith('/repos/'),
    ),
  )('rejects unregistered repository for %s', (id) => {
    expect(() =>
      prepareRequest(id as EndpointId, params, {}, new RepoAllowlist()),
    ).toThrowError(
      expect.objectContaining({ category: 'guard', code: 'repo_not_allowed' }),
    );
  });
  it('has no transport entry points for updating refs, files, settings or deleting Issues', () => {
    const routes = Object.values(endpoints).map((e) => `${e.method} ${e.path}`);
    for (const denied of [
      'PATCH /repos/{owner}/{repo}/git/refs/{ref}',
      'PUT /repos/{owner}/{repo}/contents/{path}',
      'POST /repos/{owner}/{repo}/git/commits',
      'PATCH /repos/{owner}/{repo}',
      'POST /repos/{owner}/{repo}/rulesets',
      'DELETE /repos/{owner}/{repo}/issues/{number}',
      'POST /graphql',
    ])
      expect(routes).not.toContain(denied);
  });
  it('rejects an unapproved ref write option and protected/default ref deletion', () => {
    const allowlist = new RepoAllowlist([{ owner: 'owner', name: 'project' }]);
    expect(() =>
      prepareRequest(
        'refs.create',
        {
          ...params,
          body: {
            ref: 'refs/heads/ai-office/topic',
            sha: params.sha,
            ['fo' + 'rce']: true,
          },
        },
        {},
        allowlist,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request_body' }));
    for (const safety of [
      { defaultBranch: 'ai-office/topic', protected: false },
      { defaultBranch: 'main', protected: true },
    ])
      expect(() =>
        prepareRequest('refs.delete', params, { safety }, allowlist),
      ).toThrowError(
        expect.objectContaining({ code: 'branch_delete_not_allowed' }),
      );
  });
  it('requires the exact viewer and command marker for comment deletion', () => {
    const allowlist = new RepoAllowlist([{ owner: 'owner', name: 'project' }]);
    const safety = {
      viewer: 'owner',
      author: 'owner',
      commandId: 'cmd',
      body: '<!-- ai-office:cmd=cmd -->',
    };
    expect(
      prepareRequest('comments.delete', params, { safety }, allowlist).spec
        .method,
    ).toBe('DELETE');
    for (const changed of [
      { author: 'other' },
      { commandId: 'different' },
      { body: 'ordinary comment' },
    ])
      expect(() =>
        prepareRequest(
          'comments.delete',
          params,
          { safety: { ...safety, ...changed } },
          allowlist,
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'comment_delete_not_allowed' }),
      );
  });
  it('contains neither prohibited IO imports nor forbidden write switches in production source', () => {
    const directory = new URL('../', import.meta.url);
    const files = readdirSync(directory, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      expect(source, file).not.toContain('fo' + 'rce');
      expect(source, file).not.toMatch(
        /(?:node:)?(?:child_process|fs(?:\/promises)?)['"]/,
      );
    }
  });
});

describe('account-scoped endpoints (v0.1.1 repo picker)', () => {
  const viewerRepos = { affiliation: 'owner', sort: 'pushed', per_page: 100 };
  const refused = expect.objectContaining({
    category: 'guard',
    code: 'account_request_not_allowed',
  });
  it('lists exactly three endpoints outside /repos/{owner}/{repo}, all GET', () => {
    expect(
      Object.entries(endpoints)
        .filter(([, e]) => !e.path.startsWith('/repos/{owner}/{repo}'))
        .map(([id, e]) => `${id} ${e.method} ${e.path}`)
        .sort(),
    ).toEqual([
      'rateLimit.get GET /rate_limit',
      'user.get GET /user',
      'user.repos GET /user/repos',
    ]);
  });
  it('allows one page of the viewer’s own repos without the repo allowlist', () => {
    const { url, write } = prepareRequest(
      'user.repos',
      { query: viewerRepos },
      {},
      new RepoAllowlist(),
    );
    expect(write).toBe(false);
    expect(url.toString()).toBe(
      'https://api.github.com/user/repos?affiliation=owner&per_page=100&sort=pushed',
    );
  });
  it.each([
    ['another affiliation', { ...viewerRepos, affiliation: 'all' }],
    ['a second page', { ...viewerRepos, page: 2 }],
    ['an extra filter', { ...viewerRepos, visibility: 'private' }],
    ['a smaller page', { ...viewerRepos, per_page: 50 }],
    ['a missing parameter', { affiliation: 'owner', per_page: 100 }],
    ['no query', undefined],
  ])('refuses /user/repos with %s', (_, query) => {
    expect(() =>
      prepareRequest(
        'user.repos',
        query ? { query } : {},
        {},
        new RepoAllowlist(),
      ),
    ).toThrowError(refused);
  });
  it('still refuses other unscoped calls', () => {
    // Identity and rate limit stay query-free.
    for (const id of ['user.get', 'rateLimit.get'] as const)
      expect(() =>
        prepareRequest(id, { query: viewerRepos }, {}, new RepoAllowlist()),
      ).toThrowError(refused);
    // Ids outside the table never reach the transport.
    for (const id of ['user.orgs', 'search.repos', 'repos.forUser'])
      expect(() =>
        prepareRequest(id as EndpointId, {}, {}, new RepoAllowlist()),
      ).toThrowError(expect.objectContaining({ code: 'endpoint_not_allowed' }));
    // A body on the account read is refused like any GET body.
    expect(() =>
      prepareRequest(
        'user.repos',
        { query: viewerRepos, body: {} },
        {},
        new RepoAllowlist(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request_body' }));
  });
});
