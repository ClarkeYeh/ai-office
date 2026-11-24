import { describe, expect, it } from 'vitest';
import { refusalReason } from './persistence-failures.js';
import { ROOT } from './safety.js';
import {
  TapeLeakError,
  assertTapeSafe,
  diagnoseTapeLeak,
} from './tape-normalization.js';

// M5-FX-TAPEDIAG: a refused tape names its section, field kind and rule only.
const clean = () => ({
  format: 2,
  clockReads: [0, 1000],
  source: 'live',
  startedAt: '2026-11-24T00:00:00.000Z',
  pushes: [
    {
      branch: 'ai-office/t000000000001-poll',
      base: 'main',
      sha: 'a'.repeat(40),
    },
  ],
  recordings: [
    {
      apiVersion: '2022-11-28',
      method: 'GET',
      pathTemplate: '/repos/{owner}/{repo}/issues/{number}',
      path: `${ROOT}/issues/1`,
      query: [['per_page', '100']] as [string, string][],
      requestBodySha256: 'b'.repeat(64),
      status: 200,
      headers: { etag: 'W/"' + 'c'.repeat(64) + '"' } as Record<string, string>,
      response: { number: 1, state: 'open' },
    },
  ],
});
type Tape = ReturnType<typeof clean>;
const refused = (edit: (tape: Tape) => void): string => {
  const tape = clean();
  edit(tape);
  try {
    assertTapeSafe(tape);
  } catch (error) {
    expect(error).toBeInstanceOf(TapeLeakError);
    return (error as TapeLeakError).label!;
  }
  throw new Error('expected a refusal');
};
const secret = 'Xq7' + 'Zk2Lm9Pw4Rt6Yv8Bn1Cd3Fg5';

describe('tape leak diagnosis', () => {
  it('accepts the clean synthetic tape', () => {
    expect(() => assertTapeSafe(clean())).not.toThrow();
  });
  it.each([
    [
      'recordings/request query/entropy',
      (t: Tape) => t.recordings[0]!.query.push(['since', secret]),
    ],
    [
      'recordings/request path/entropy',
      (t: Tape) => {
        t.recordings[0]!.pathTemplate = '/repos/{owner}/{repo}/issues';
        t.recordings[0]!.path = `${ROOT}/issues/${secret}`;
      },
    ],
    [
      'recordings/response header/entropy',
      (t: Tape) => (t.recordings[0]!.headers.link = secret),
    ],
    [
      'recordings/response body/domain',
      (t: Tape) =>
        Object.assign(t.recordings[0]!.response, { site: 'example.com' }),
    ],
    [
      'recordings/request metadata/ip address',
      (t: Tape) => (t.recordings[0]!.method = '10.0.0.1'),
    ],
    [
      'pushes/push ref/hostname',
      (t: Tape) => (t.pushes[0]!.base = 'localhost'),
    ],
    ['pushes/push sha/entropy', (t: Tape) => (t.pushes[0]!.sha = secret)],
    [
      'pushes/push signature/email',
      (t: Tape) =>
        Object.assign(t.pushes[0]!, { author: 'person@private.invalid.tw' }),
    ],
    [
      'clockReads/clock read/url',
      (t: Tape) =>
        (t.clockReads as unknown[]).push('https://elsewhere.invalid/x'),
    ],
    [
      'other/envelope/home path',
      (t: Tape) => (t.startedAt = '/Users/someone/x'),
    ],
    [
      'recordings/response body/token prefix',
      (t: Tape) =>
        Object.assign(t.recordings[0]!.response, {
          note: 'ghp_' + 'x'.repeat(8),
        }),
    ],
    [
      'recordings/response body/private key',
      (t: Tape) =>
        Object.assign(t.recordings[0]!.response, { pem: 'PRIVATE KEY' }),
    ],
    [
      'recordings/response body/unsummarized body',
      (t: Tape) =>
        Object.assign(t.recordings[0]!.response, { body: 'plain words' }),
    ],
    [
      'recordings/response body/secret field',
      (t: Tape) =>
        Object.assign(t.recordings[0]!.response, { password: 'plain' }),
    ],
    [
      'recordings/response body/host field',
      (t: Tape) =>
        Object.assign(t.recordings[0]!.response, { hostname: 'plain' }),
    ],
    [
      'recordings/response body key/domain',
      (t: Tape) =>
        Object.assign(t.recordings[0]!.response, { 'example.com': 1 }),
    ],
  ])('labels %s without the value', (label, edit) => {
    const got = refused(edit);
    expect(got).toBe(label);
    for (const value of [secret, 'example.com', 'person@', '/Users/someone'])
      expect(got).not.toContain(value);
  });
  it('labels a raw tape the normalizer refuses by its sensitive rule', () => {
    const tape = clean();
    tape.pushes[0]!.branch = 'ai-office/aio_seat_' + 'y'.repeat(8);
    expect(diagnoseTapeLeak(tape)).toBe('pushes/push ref/token prefix');
  });
  it('carries the label into the safe refusal reason', () => {
    expect(
      refusalReason(
        new TapeLeakError('private value', 'recordings/request query/entropy'),
      ),
    ).toBe('tape leak scan: recordings/request query/entropy');
    expect(refusalReason(new TapeLeakError('private value'))).toBe(
      'tape leak scan',
    );
  });
});
