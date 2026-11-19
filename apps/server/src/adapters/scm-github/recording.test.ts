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
