import { describe, expect, it, vi } from 'vitest';
import { REPO_CANDIDATE_PROBLEMS } from '@ai-office/contracts/api';
import { PortError } from '../../ports/errors.js';
import { parseGithubOrigin } from '../../ports/refs.js';
import type { LocalRepo, RuntimePort } from '../../ports/runtime.js';
import type { ViewerRepo } from '../../ports/scm.js';
import {
  matchRepoCandidates,
  RepoCandidateQueries,
} from './repo-candidates.js';

const local = (
  path: string,
  originUrl: string | null,
  isGitMainWorktree = true,
): LocalRepo => ({
  path,
  displayName: path.split('/').at(-1)!,
  runtimeRepoId: `orca-${path.split('/').at(-1)}`,
  isGitMainWorktree,
  originUrl,
});
const remote = (
  owner: string,
  name: string,
  extra: Partial<ViewerRepo> = {},
): ViewerRepo => ({
  owner,
  name,
  visibility: 'public',
  archived: false,
  pushedAt: '2026-11-20T00:00:00Z',
  defaultBranch: 'main',
  ...extra,
});

describe('parseGithubOrigin (shared with registration)', () => {
  it.each([
    ['https://github.com/octo/app.git', { owner: 'octo', name: 'app' }],
    ['https://github.com/octo/app', { owner: 'octo', name: 'app' }],
    ['https://github.com/octo/app/', { owner: 'octo', name: 'app' }],
    ['git@github.com:octo/my.app.git', { owner: 'octo', name: 'my.app' }],
    [
      'ssh://git@github.com/Octo-1/app_x.git',
      { owner: 'Octo-1', name: 'app_x' },
    ],
  ])('parses %s', (url, expected) => {
    expect(parseGithubOrigin(url)).toEqual(expected);
  });
  it.each([
    null,
    undefined,
    '',
    'https://gitlab.com/octo/app.git',
    'https://github.com/octo',
    'https://github.com/octo/app/tree/main',
    'https://user:token@github.com/octo/app.git',
    'http://github.com/octo/app.git',
    'file:///synthetic/repo',
  ])('refuses %s', (url) => {
    expect(parseGithubOrigin(url)).toBeNull();
  });
});

describe('matchRepoCandidates', () => {
  it('keeps git main worktrees, flags missing GitHub origins, matches remotes ignoring case', () => {
    const result = matchRepoCandidates({
      local: [
        local('/synthetic/app', 'git@github.com:Octo/App.git'),
        local('/synthetic/notes', null),
        local('/synthetic/lab', 'https://gitlab.com/octo/lab.git'),
        local('/synthetic/sub', 'git@github.com:octo/sub.git', false),
        local('/synthetic/app-copy', 'https://github.com/octo/app'),
      ],
      remote: [
        remote('octo', 'app'),
        remote('octo', 'site', { visibility: 'private' }),
        remote('octo', 'old', { archived: true, pushedAt: null }),
      ],
      registered: [
        {
          localPath: '/synthetic/app/',
          github: { owner: 'OCTO', name: 'APP' },
        },
      ],
    });
    expect(result.sources).toEqual({ orca: 'ok', github: 'ok' });
    expect(result.local).toEqual([
      {
        path: '/synthetic/app',
        displayName: 'app',
        github: { owner: 'Octo', name: 'App' },
        registered: true,
      },
      {
        path: '/synthetic/notes',
        displayName: 'notes',
        github: null,
        registered: false,
        problem: 'invalid_github_origin',
      },
      {
        path: '/synthetic/lab',
        displayName: 'lab',
        github: null,
        registered: false,
        problem: 'invalid_github_origin',
      },
      {
        path: '/synthetic/app-copy',
        displayName: 'app-copy',
        github: { owner: 'octo', name: 'app' },
        registered: false,
      },
    ]);
    for (const { problem } of result.local)
      if (problem)
        expect(REPO_CANDIDATE_PROBLEMS as readonly string[]).toContain(problem);
    expect(result.remote).toEqual([
      {
        owner: 'octo',
        name: 'app',
        visibility: 'public',
        archived: false,
        pushedAt: '2026-11-20T00:00:00Z',
        // The first local clone wins.
        local: { path: '/synthetic/app' },
        registered: true,
      },
      {
        owner: 'octo',
        name: 'site',
        visibility: 'private',
        archived: false,
        pushedAt: '2026-11-20T00:00:00Z',
        local: null,
        registered: false,
      },
      {
        owner: 'octo',
        name: 'old',
        visibility: 'public',
        archived: true,
        pushedAt: null,
        local: null,
        registered: false,
      },
    ]);
  });
  it('reports a failed source as unavailable and still answers the other', () => {
    const noGithub = matchRepoCandidates({
      local: [local('/synthetic/app', 'git@github.com:octo/app.git')],
      remote: null,
      registered: [],
    });
    expect(noGithub.sources).toEqual({ orca: 'ok', github: 'unavailable' });
    expect(noGithub.local).toHaveLength(1);
    expect(noGithub.remote).toEqual([]);
    const noOrca = matchRepoCandidates({
      local: null,
      remote: [remote('octo', 'app')],
      registered: [],
    });
    expect(noOrca.sources).toEqual({ orca: 'unavailable', github: 'ok' });
    expect(noOrca.remote).toEqual([
      expect.objectContaining({ name: 'app', local: null }),
    ]);
  });
});

describe('RepoCandidateQueries', () => {
  const ports = (
    listLocalRepos: RuntimePort['listLocalRepos'],
    listViewerRepos: () => Promise<ViewerRepo[]>,
    timeoutMs?: number,
  ) => {
    const logger = { warn: vi.fn() };
    const queries = new RepoCandidateQueries({
      runtime: { listLocalRepos },
      scm: { listViewerRepos },
      registered: () => [],
      logger,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { queries, logger };
  };
  it('survives either port failing, logging only the error category', async () => {
    const down = new PortError('transient', 'runtime_unavailable', 'down');
    const a = ports(
      async () => {
        throw down;
      },
      async () => [remote('octo', 'app')],
    );
    expect(await a.queries.listRepoCandidates()).toMatchObject({
      local: [],
      remote: [{ name: 'app' }],
      sources: { orca: 'unavailable', github: 'ok' },
    });
    expect(a.logger.warn).toHaveBeenCalledWith(
      {
        source: 'orca',
        error: expect.objectContaining({ category: 'transient' }),
      },
      'repo candidates source unavailable',
    );
    const b = ports(
      async () => [local('/synthetic/app', 'git@github.com:octo/app.git')],
      async () => {
        throw new PortError('guard', 'account_request_not_allowed', 'no');
      },
    );
    expect(await b.queries.listRepoCandidates()).toMatchObject({
      local: [{ path: '/synthetic/app' }],
      remote: [],
      sources: { orca: 'ok', github: 'unavailable' },
    });
  });
  it('asks the runtime for a fresh list only on refresh', async () => {
    const listLocalRepos = vi.fn(async () => [] as LocalRepo[]);
    const { queries } = ports(listLocalRepos, async () => []);
    await queries.listRepoCandidates();
    expect(listLocalRepos).toHaveBeenLastCalledWith({});
    await queries.listRepoCandidates({ refresh: true });
    expect(listLocalRepos).toHaveBeenLastCalledWith({ fresh: true });
  });
  it('reports a source slower than the timeout as unavailable', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = ports(
        () => new Promise<LocalRepo[]>(() => {}),
        async () => [],
        1000,
      );
      const pending = queries.listRepoCandidates();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pending).sources).toEqual({
        orca: 'unavailable',
        github: 'ok',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
