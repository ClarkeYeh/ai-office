import { scenarioTime } from '../../test-support/github/scenario-time.js';
import { assembleContractScm } from './test-support/assembly.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createGithubScm, RepoAllowlist } from './index.js';
import {
  RecordingFetch,
  ReplayFetch,
  type Recording,
} from '../../test-support/github/recording.js';
import {
  contractRepo,
  contractUrl,
} from '../../test-support/github/contract-transport.js';
import { encodedRefScenario } from '../../test-support/github/ref-paths.js';
import { tapePath } from '../../test-support/github/contract-binding.js';
import { createRedactor } from '@ai-office/redaction';

it('replays the integrator percent-encoded ref probe strictly', async ({
  skip,
}) => {
  const path = tapePath('encoded refs');
  if (!existsSync(path))
    skip('Pending integrator live recording of encoded refs');
  const rows = JSON.parse(await readFile(path, 'utf8')) as Recording[];
  const { startedAt, clockReads } = JSON.parse(
    await readFile(path + '.clock.json', 'utf8'),
  ) as { startedAt: string; clockReads: number[] };
  const replay = new ReplayFetch(rows);
  const time = scenarioTime('replay', clockReads);
  await encodedRefScenario(
    replay.fetch,
    '000000000001',
    startedAt,
    assembleContractScm,
    time,
  );
  replay.assertConsumed();
  time.assertConsumed();
});

it('keeps synthetic token and body secrets out of recorded fixtures and adapter diagnostics, then strictly replays getIssue', async () => {
  const token = 'ghp_' + 'SyntheticSecretForContractOnly123456789';
  const body = 'Synthetic approval: private.person@example.invalid';
  const recorder = new RecordingFetch(
    async () =>
      new Response(
        JSON.stringify({
          body,
          updated_at: '2026-01-01T00:00:00Z',
          labels: [],
        }),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'set-cookie': 'private-cookie',
            etag: '"test"',
          },
        },
      ),
  );
  const redactor = createRedactor();
  const options = {
    tokenProvider: async () => token,
    repoAllowlist: new RepoAllowlist([contractRepo]),
    maskSecrets: <T>(v: T): T => redactor.sanitize(v) as T,
  };
  const live = createGithubScm({ ...options, fetch: recorder.fetch });
  const issue = { repo: contractRepo, number: 44 };
  const result = await live.getIssue(issue);
  expect(result.body).toBe(body);
  const serialized = JSON.stringify({
    fixtures: recorder.recordings,
    diagnostics: live.diagnostics(),
  });
  expect(serialized).not.toContain(token);
  expect(serialized).not.toContain(body);
  expect(serialized).not.toContain('private.person@');
  expect(serialized).not.toContain('private-cookie');
  const replay = new ReplayFetch(recorder.recordings, { bodies: [body] });
  expect(() => replay.assertConsumed()).toThrow();
  const scm = createGithubScm({ ...options, fetch: replay.fetch });
  expect(await scm.getIssue(issue)).toEqual(result);
  replay.assertConsumed();
  await expect(replay.fetch(contractUrl + '/issues/44')).rejects.toThrow(
    'mismatch',
  );
});

it('records GitHub-shaped IDs and URLs, normalizes, persists and replays through marker URL schemas', async () => {
  const { TapeNormalizer, assertTapeSafe } =
    await import('../../test-support/github/tape-normalization.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const body = '<!-- ai-office:cmd=roundtrip -->';
  const html = 'https://github.com/ClarkeYeh/ai-office-spike/issues/42';
  const recorder = new RecordingFetch(async (input) => {
    const request = new Request(input);
    return Response.json(
      new URL(request.url).pathname === '/user'
        ? {
            login: 'ClarkeYeh',
            node_id: 'U_kwDOSynthetic123',
            avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
          }
        : [
            {
              number: 42,
              body,
              html_url: html,
              url: contractUrl + '/issues/42',
              node_id: 'I_kwDOSynthetic456',
              user: { login: 'ClarkeYeh', node_id: 'U_kwDOSynthetic123' },
            },
          ],
    );
  });
  const options = {
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    sleep: async () => {},
    registeredAt: () => '2026-01-01T00:00:00Z',
  };
  const live = assembleContractScm({ ...options, fetch: recorder.fetch });
  const expected = await live.findByMarker(contractRepo, 'roundtrip', {
    kind: 'issue',
  });
  const normalized = new TapeNormalizer().value(recorder.recordings);
  assertTapeSafe(normalized);
  expect(JSON.stringify(normalized)).not.toContain('kwDOSynthetic');
  const dir = await mkdtemp(join(tmpdir(), 'github-tape-'));
  try {
    const path = join(dir, 'tape.json');
    await recorder.save(path);
    const replay = new ReplayFetch(
      JSON.parse(await readFile(path, 'utf8')) as Recording[],
      { bodies: [body] },
    );
    const scm = assembleContractScm({ ...options, fetch: replay.fetch });
    expect(
      await scm.findByMarker(contractRepo, 'roundtrip', { kind: 'issue' }),
    ).toEqual(expected);
    expect(expected?.url).toBe(html);
    replay.assertConsumed();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps URL-shaped opaque bodies recoverable by their original hash', async () => {
  const body = contractUrl + '/issues/42';
  const recorder = new RecordingFetch(async () =>
    Response.json({ body, updated_at: '2026-01-01T00:00:00Z', labels: [] }),
  );
  const issue = { repo: contractRepo, number: 42 };
  await recorder.fetch(contractUrl + '/issues/42');
  const replay = new ReplayFetch(recorder.recordings, { bodies: [body] });
  const scm = assembleContractScm({
    fetch: replay.fetch,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    sleep: async () => {},
    registeredAt: () => '2026-01-01T00:00:00Z',
  });
  expect((await scm.getIssue(issue)).body).toBe(body);
  replay.assertConsumed();
});

it('round-trips the encoded-ref scenario with public GitHub metadata without network access', async () => {
  const runId = 'abcdef123456';
  const sha = 'a'.repeat(40);
  const branch = `ai-office/t${runId}-encoded/path`;
  let exists = false;
  const recorder = new RecordingFetch(async (input, init) => {
    const request = new Request(input, init);
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path === '/user') return Response.json({ login: 'ClarkeYeh' });
    if (path.includes('/rules/')) return Response.json([]);
    if (request.method === 'POST') {
      exists = true;
      return Response.json({ ref: `refs/heads/${branch}`, object: { sha } });
    }
    if (request.method === 'DELETE') {
      exists = false;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/ai-office-spike'))
      return Response.json({
        default_branch: 'main',
        visibility: 'public',
        archived: false,
        allow_merge_commit: true,
        permissions: { push: true },
        ssh_url: 'git@github.com:ClarkeYeh/ai-office-spike.git',
        git_url: 'git://github.com/ClarkeYeh/ai-office-spike.git',
        clone_url: 'https://github.com/ClarkeYeh/ai-office-spike.git',
        owner: { url: 'https://api.github.com/users/ClarkeYeh/followers' },
        committer: { email: 'noreply@github.com' },
        author: { email: '123+ClarkeYeh@users.noreply.github.com' },
      });
    if (path.includes('/branches/')) return Response.json({ protected: false });
    if (path.endsWith('/heads/main'))
      return Response.json({ ref: 'refs/heads/main', object: { sha } });
    return exists
      ? Response.json({ ref: `refs/heads/${branch}`, object: { sha } })
      : Response.json({ message: 'Not Found' }, { status: 404 });
  }, runId);
  const time = scenarioTime('live');
  const startedAt = '2026-01-01T00:00:00Z';
  await encodedRefScenario(
    recorder.fetch,
    runId,
    startedAt,
    assembleContractScm,
    time,
  );
  const { assertTapeSafe } =
    await import('../../test-support/github/tape-normalization.js');
  assertTapeSafe(recorder.recordings);
  expect(
    recorder.recordings.some((row) =>
      JSON.stringify(row.response).includes(
        'refs/heads/ai-office/t000000000001-encoded/path',
      ),
    ),
  ).toBe(true);
  const replay = new ReplayFetch(recorder.recordings);
  const replayTime = scenarioTime('replay', time.reads);
  await encodedRefScenario(
    replay.fetch,
    '000000000001',
    startedAt,
    assembleContractScm,
    replayTime,
  );
  replay.assertConsumed();
  replayTime.assertConsumed();
});

// Synthetic stand-in for the private address in old spike history (FX-TAPE).
const privateEmail = 'private.person@private.invalid';
const signature = {
  name: 'Owner',
  email: privateEmail,
  date: '2026-01-01T00:00:00Z',
};
function spikeMain(leak?: unknown): typeof fetch {
  return async (input, init) => {
    const path = decodeURIComponent(
      new URL(new Request(input, init).url).pathname,
    );
    if (path === '/user')
      return Response.json({ login: 'ClarkeYeh', ...(leak ?? {}) });
    if (path.includes('/rules/')) return Response.json([]);
    if (path.endsWith('/protection')) return Response.json({});
    if (path.endsWith('/branches/main'))
      return Response.json({
        name: 'main',
        protected: true,
        commit: {
          sha: 'a'.repeat(40),
          commit: {
            author: signature,
            committer: signature,
            message: 'Old spike history',
            tree: { sha: 'b'.repeat(40) },
          },
        },
      });
    return Response.json({
      default_branch: 'main',
      visibility: 'public',
      archived: false,
      allow_merge_commit: true,
      permissions: { push: true },
    });
  };
}
const offline = {
  clock: { now: () => new Date('2026-01-01T00:00:00Z') },
  sleep: async () => {},
  registeredAt: () => '2026-01-01T00:00:00Z',
};

it('records branches.get on a main whose commit carries a private email, then strictly replays inspectRepo', async () => {
  const recorder = new RecordingFetch(spikeMain());
  const live = await assembleContractScm({
    ...offline,
    fetch: recorder.fetch,
  }).inspectRepo(contractRepo);
  expect(live.defaultBranchProtected).toBe(true);
  recorder.assertNoLeak();
  expect(JSON.stringify(recorder.recordings)).not.toContain(privateEmail);
  const replay = new ReplayFetch(recorder.recordings);
  expect(
    await assembleContractScm({ ...offline, fetch: replay.fetch }).inspectRepo(
      contractRepo,
    ),
  ).toEqual(live);
  replay.assertConsumed();
});

it('raises a leak the adapter maps to github_unavailable as a harness TapeLeakError and saves nothing', async () => {
  const { TapeLeakError } =
    await import('../../test-support/github/tape-normalization.js');
  const recorder = new RecordingFetch(spikeMain({ email: privateEmail }));
  await expect(
    assembleContractScm({ ...offline, fetch: recorder.fetch }).inspectRepo(
      contractRepo,
    ),
  ).rejects.toMatchObject({ code: 'github_unavailable' });
  expect(() => recorder.assertNoLeak()).toThrow(TapeLeakError);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'aio-tape-leak-'));
  try {
    const path = join(dir, 'tape.json');
    await expect(recorder.save(path)).rejects.toBeInstanceOf(TapeLeakError);
    expect(existsSync(path)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
