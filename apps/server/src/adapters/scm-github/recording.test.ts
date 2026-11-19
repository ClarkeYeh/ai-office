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
