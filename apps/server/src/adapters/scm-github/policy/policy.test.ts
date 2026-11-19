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
