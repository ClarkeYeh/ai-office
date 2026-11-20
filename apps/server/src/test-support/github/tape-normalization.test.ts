import { expect, it } from 'vitest';
import {
  TapeLeakError,
  TapeNormalizer,
  assertTapeSafe,
} from './tape-normalization.js';
import { API, ROOT, REPO } from './safety.js';

it('maps each distinct node consistently and keeps normalized URLs valid and scan-safe', () => {
  const normalize = new TapeNormalizer();
  const raw = {
    node_id: 'I_kwDOSynthetic123',
    url: `${API}${ROOT}/issues/42`,
    html_url: `https://github.com/${REPO}/issues/42`,
    user: {
      node_id: 'U_kwDOSynthetic456',
      avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
    },
  };
  const first = normalize.value(raw);
  expect(first.node_id).toBe('NODE_000001');
  expect(first.user.node_id).toBe('NODE_000002');
  expect(normalize.value({ node_id: raw.node_id }).node_id).toBe(first.node_id);
  for (const url of [first.url, first.html_url, first.user.avatar_url])
    expect(new URL(url).protocol).toBe('https:');
  expect(first.url).toBe(`https://github.com/${REPO}/__api__/issues/42`);
  expect(new TapeNormalizer().value(first)).toEqual(first);
  expect(() => assertTapeSafe(first)).not.toThrow();
});

it.each([
  'ghp_' + 'SyntheticSecret123456789',
  'private.person@private.invalid',
  '/Users/synthetic/private',
  '/home/synthetic/private',
  'C:\\Users\\synthetic\\private',
])('rejects sensitive normalized metadata without logging it', (secret) => {
  expect(() => assertTapeSafe({ metadata: secret })).toThrow(
    'Tape leak scan failed',
  );
  expect(() => new TapeNormalizer().value({ node_id: secret })).toThrow();
  expect(() =>
    new TapeNormalizer().value({
      url: `${API}${ROOT}/issues?data=${encodeURIComponent(secret)}`,
    }),
  ).toThrow();
});

it('normalizes public GitHub remotes, user URLs and noreply authors into scan-safe values', () => {
  const value = new TapeNormalizer().value({
    ssh_url: `git@github.com:${REPO}.git`,
    git_url: `git://github.com/${REPO}.git`,
    clone_url: `https://github.com/${REPO}.git`,
    user: {
      url: `${API}/users/ClarkeYeh`,
      followers_url: `${API}/users/ClarkeYeh/followers`,
    },
    committer: { email: 'noreply@github.com' },
    author: { email: '123+ClarkeYeh@users.noreply.github.com' },
  });
  expect(value.ssh_url).toBe(value.clone_url);
  expect(value.git_url).toBe(value.clone_url);
  expect(value.committer.email).toBe('<github-noreply>');
  expect(value.author.email).toBe('<github-noreply>');
  for (const url of [
    value.ssh_url,
    value.git_url,
    value.clone_url,
    value.user.url,
    value.user.followers_url,
  ])
    expect(new URL(url).protocol).toBe('https:');
  expect(value.user.followers_url).toBe(
    `https://github.com/${REPO}/__users__/ClarkeYeh/followers`,
  );
  expect(() => assertTapeSafe(value)).not.toThrow();
  expect(new TapeNormalizer().value(value)).toEqual(value);
});

// Rebuilt from the integrator's eight planted samples; all values are synthetic.
const planted = [
  { token: 'ghp_' + 'SyntheticSecret123456789' },
  { token: 'github_pat_' + 'SyntheticSecret123456789' },
  { commit: { author: { email: 'user@example.org' } } },
  { body: 'Contact user@example.org' },
  { path: '/Users/synthetic/private' },
  { path: '/home/synthetic/private' },
  { node_id: 'ghp_' + 'SyntheticSecret123456789' },
  { url: `${API}${ROOT}/issues?token=ghp_SyntheticSecret123456789` },
];
it.each(planted)(
  'rejects a planted leak before normalization can conceal it (%#)',
  (value) => {
    expect(() => assertTapeSafe(new TapeNormalizer().value(value))).toThrow(
      'Tape leak scan failed',
    );
    expect(() => assertTapeSafe(value)).toThrow('Tape leak scan failed');
  },
);

it.each([
  `git@github.com:${REPO}.git?token=ghp_SyntheticSecret123456789`,
  `${API}/users/ClarkeYeh/ghp_SyntheticSecret123456789`,
  'not-noreply@github.com',
  'noreply@github.com.evil.org',
  '123+name@users.noreply.github.com.evil.org',
])('does not broaden public-field exceptions (%#)', (value) => {
  expect(() => assertTapeSafe(new TapeNormalizer().value({ value }))).toThrow();
});

// Synthetic stand-in for the private address in old spike history.
const privateEmail = 'private.person@private.invalid';
const signature = (name: string) => ({
  name,
  email: privateEmail,
  date: '2026-11-17T07:07:35Z',
});
const gitCommit = () => ({
  author: signature('Owner'),
  committer: signature('Owner'),
  message: 'Old spike history',
  tree: { sha: 'b'.repeat(40) },
  verification: { verified: false, payload: null },
});

it('replaces only git commit author/committer emails with the noreply placeholder before the leak scan', () => {
  const row = { sha: 'a'.repeat(40), commit: gitCommit() };
  const shapes = {
    'commits.get': row,
    'branches.get': { name: 'main', protected: true, commit: row },
    compare: {
      ahead_by: 1,
      base_commit: row,
      merge_base_commit: row,
      commits: [row],
    },
    'pulls.commits': [row],
  };
  const value = new TapeNormalizer().value(shapes);
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(privateEmail);
  expect(value['branches.get'].commit.commit.author).toEqual({
    name: 'Owner',
    email: '<github-noreply>',
    date: '2026-11-17T07:07:35Z',
  });
  expect(value.compare.commits[0]!.commit.committer.email).toBe(
    '<github-noreply>',
  );
  expect(value['branches.get'].protected).toBe(true);
  expect(() => assertTapeSafe(value)).not.toThrow();
  expect(new TapeNormalizer().value(value)).toEqual(value);
});

it.each([
  ['a GitHub user object', { user: { login: 'x', email: privateEmail } }],
  ['a signature outside a git commit', { author: signature('Owner') }],
  [
    'a signature with extra fields',
    {
      commit: {
        ...gitCommit(),
        author: { ...signature('Owner'), login: 'x' },
      },
    },
  ],
  ['a commit message', { commit: { ...gitCommit(), message: privateEmail } }],
  [
    'a signed commit payload',
    {
      commit: {
        ...gitCommit(),
        verification: { payload: `author Owner <${privateEmail}> 0 +0000` },
      },
    },
  ],
  [
    'a signature name',
    { commit: { ...gitCommit(), author: signature(privateEmail) } },
  ],
  ['an issue body', { body: `Contact ${privateEmail}` }],
])('still rejects an email in %s', (_, value) => {
  expect(() => new TapeNormalizer().value(value)).toThrow(TapeLeakError);
});

const recorded = (path: string, pathTemplate: string) => [
  { method: 'GET', pathTemplate, path, query: [], status: 200, response: {} },
];
it.each([
  ['/pulls/144', '/pulls/{number}'],
  ['/issues/57', '/issues/{number}'],
  ['/issues/57/comments', '/issues/{number}/comments'],
  ['/issues/comments/3456789012', '/issues/comments/{id}'],
  [`/commits/${'a1'.repeat(20)}/check-runs`, '/commits/{ref}'],
  [
    `/compare/${'a1'.repeat(20)}...ai-office%2Ft000000000001-worker`,
    '/compare/{ref}',
  ],
])(
  'exempts the structural request path %s from the entropy rule',
  (path, t) => {
    expect(() =>
      assertTapeSafe(recorded(ROOT + path, '/repos/{owner}/{repo}' + t)),
    ).not.toThrow();
  },
);

it.each([
  [
    'a token-like segment',
    '/pulls/ghp_SyntheticSecret123456789',
    '/pulls/{number}',
  ],
  ['an email-like segment', `/issues/${privateEmail}`, '/issues/{number}'],
  ['an unlisted template', '/hooks/144x9Kq2Zr7Lm3Vb8', '/hooks/{id}'],
  ['a mismatched template', '/pulls/144x9Kq2Zr7Lm3Vb8Wq', '/pulls/{number}'],
  [
    'a high-entropy ref',
    '/git/ref/heads/x9Kq2Zr7Lm3Vb8Wq5Tn1',
    '/git/ref/heads/{ref}',
  ],
  [
    'a high-entropy segment under ai-office/',
    '/branches/ai-office/q7x9m2k4p8w3z6r1t5y0u2i8o4p6a3s9d1f7g5h2',
    '/branches/{ref}',
  ],
])('still scans a request path with %s', (_, path, t) => {
  expect(() =>
    assertTapeSafe(recorded(ROOT + path, '/repos/{owner}/{repo}' + t)),
  ).toThrow(TapeLeakError);
});

it('does not exempt a concrete path that appears outside a request signature', () => {
  expect(() =>
    assertTapeSafe({ note: `${ROOT}/pulls/144x9Kq2Zr7Lm3Vb8Wq` }),
  ).toThrow(TapeLeakError);
});

it('normalizes exact public service noreply trailers in commit messages', () => {
  const message = [
    'Add greeting',
    '',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    'Co-authored-by: GitHub <noreply@github.com>',
    'Co-authored-by: Owner <123+Owner@users.noreply.github.com>',
  ].join('\n');
  const value = new TapeNormalizer().value({
    commit: { ...gitCommit(), message },
  });
  expect(value.commit.message).toBe(
    [
      'Add greeting',
      '',
      'Co-Authored-By: Claude Opus 5.5 <<anthropic-noreply>>',
      'Co-authored-by: GitHub <<github-noreply>>',
      'Co-authored-by: Owner <<github-noreply>>',
    ].join('\n'),
  );
  expect(() => assertTapeSafe(value)).not.toThrow();
  expect(new TapeNormalizer().value(value)).toEqual(value);
});

it.each([
  'Co-Authored-By: Someone <someone@example.org>',
  'Co-Authored-By: Claude <xnoreply@anthropic.com>',
  'Co-Authored-By: Claude <noreply@anthropic.com.evil.org>',
  'Co-Authored-By: Claude <NoReply@Anthropic.com>',
])('still rejects any other email in a commit message (%#)', (message) => {
  expect(() =>
    new TapeNormalizer().value({ commit: { ...gitCommit(), message } }),
  ).toThrow(TapeLeakError);
});

it('keeps service noreply literals scanned outside commit messages', () => {
  expect(() =>
    new TapeNormalizer().value({ title: 'Ping noreply@anthropic.com' }),
  ).toThrow(TapeLeakError);
});
