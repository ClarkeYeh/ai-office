import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ActivityMetaSchema,
  PolicyHitSchema,
} from '@ai-office/contracts/events';
import { RawAgentOutputSchema } from '../../ports/runtime-events.js';
import { createRedactor } from './index.js';

const redactor = createRedactor({ defaultBranch: 'trunk' });
function output(input: unknown, name = 'Bash') {
  return RawAgentOutputSchema.parse({
    type: 'agent.output',
    externalKey: 'e1',
    agent: 'a1',
    occurredAt: '2026-11-17T00:00:00Z',
    messageId: 'm1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 't1', name, input }],
  });
}
const cases = [
  [
    'orca-dispatch',
    'orca orchestration worker-start --agent codex',
    'orca orchestration worker-list',
  ],
  [
    'orca-run-use',
    '"/opt/bin/orca" orchestration "run-use" run1',
    'orca orchestration run-list',
  ],
  [
    'orca-worker-stop',
    'true && orca orchestration worker-release --id x',
    'orca orchestration worker-keep-open',
  ],
  [
    'orca-agent-launch',
    'true\norca worktree create --agent=codex',
    'orca worktree create --name plain',
  ],
  ['gh-merge', "gh pr 'merge' 12", 'gh pr view 12'],
  [
    'gh-comment',
    'gh issue comment 12 --body hello',
    'gh issue view 12 --comments',
  ],
  ['gh-label', 'gh label create bug', 'gh issue list --label bug'],
  ['gh-pr-create', 'gh pr create --fill --base main', 'gh pr list'],
  ['gh-pr-edit', 'gh pr edit 12 --base main', 'gh pr view 12 --json base'],
  ['gh-issue-create', 'gh issue create --title x --body y', 'gh issue view 3'],
  [
    'push-default-branch',
    'git -C /tmp/repo push origin HEAD:refs/heads/trunk',
    'git push origin trunk:feature',
  ],
] as const;

describe('policy detection', () => {
  it.each(cases)(
    '%s has positive and negative examples',
    (rule, positive, negative) => {
      const hits = redactor.toActivity(
        output({ command: positive }),
      ).policyHits;
      expect(hits).toEqual([
        {
          rule,
          severity: ['gh-comment', 'gh-label'].includes(rule)
            ? 'medium'
            : 'high',
          messageId: 'm1',
        },
      ]);
      hits.forEach((hit) => PolicyHitSchema.parse(hit));
      expect(
        redactor.toActivity(output({ command: negative })).policyHits,
      ).toEqual([]);
    },
  );
  it.each([
    ['orca orchestration dispatch', 'orca-dispatch'],
    ['orca orchestration run-create', 'orca-dispatch'],
    ['orca orchestration worker-stop', 'orca-worker-stop'],
    ['orca agent launch', 'orca-agent-launch'],
    ['orca terminal create', 'orca-agent-launch'],
    ['orca worktree create --agent codex', 'orca-agent-launch'],
    ['orca orchestration \\\nrun-use x', 'orca-run-use'],
    ["bash -lc 'gh pr merge 1'", 'gh-merge'],
    ['git push origin +feature:trunk', 'push-default-branch'],
    ['git push origin trunk', 'push-default-branch'],
    ['git push --repo=origin HEAD:trunk', 'push-default-branch'],
    ['git push --all origin', 'push-default-branch'],
    ["bash -lc 'gh pr edit 3 --base main'", 'gh-pr-edit'],
    ['gh api -X PATCH repos/o/r/pulls/3 -f base=main', 'gh-pr-edit'],
    ['gh api repos/o/r/pulls -f head=x -f base=main', 'gh-pr-create'],
    ['gh api --method POST /repos/o/r/issues -f title=x', 'gh-issue-create'],
  ])('detects %s', (command, rule) => {
    expect(
      redactor
        .toActivity(output({ cmd: command }))
        .policyHits.map((h) => h.rule),
    ).toContain(rule);
  });
  it.each([
    'echo "gh pr merge 1"',
    'orca orchestration run-useful',
    'gh pr merger',
    'git push origin trunk-backup',
    'git push origin refs/heads/feature',
    'gh pr editor',
    'gh api repos/o/r/pulls/3',
    'gh api repos/o/r/issues',
    'gh api -X PATCH repos/o/r/issues/3/comments/9 -f body=x',
  ])('does not flag %s', (command) => {
    expect(redactor.toActivity(output({ command })).policyHits).toEqual([]);
  });
  it('scans only tool input commands and deduplicates hits per message', () => {
    const event = output({ command: 'gh pr merge 1 && gh pr merge 2' });
    event.blocks.push(
      { type: 'text', text: 'orca orchestration run-use x' },
      { type: 'tool_result', toolUseId: 't1', output: 'orca terminal create' },
    );
    expect(redactor.toActivity(event).policyHits.map((h) => h.rule)).toEqual([
      'gh-merge',
    ]);
    expect(
      redactor.toActivity(output({ content: 'gh pr merge 1' }, 'Write'))
        .policyHits,
    ).toEqual([]);
  });
});

describe('follow-up policy gaps', () => {
  it.each([
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api repos/o/r/pulls/12/merge --method=PUT',
    'gh api -XPUT /repos/o/r/pulls/12/merge',
    'gh api --method PUT https://api.github.com/repos/o/r/pulls/12/merge',
    'gh api repos/{owner}/{repo}/merges -f base=main -f head=feature',
    'gh api -X POST repos/o/r/merges --input request.json',
    'gh api repos/o/r/merges --raw-field=base=main',
    'gh api repos/o/r/merges -Fbase=main',
    'gh api repos/o/r/merges --input=request.json',
    'true && /opt/bin/gh api --hostname github.com -H "Accept: application/json" -X PUT "repos/o/r/pulls/12/merge"',
  ])('detects high-severity API merges: %s', (command) => {
    expect(redactor.toActivity(output({ command })).policyHits).toEqual([
      { rule: 'gh-merge', severity: 'high', messageId: 'm1' },
    ]);
  });
  it.each([
    'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc',
    'gh api repos/o/r/git/refs/heads/main --method PATCH -f sha=abc',
    'gh api --method=PATCH /repos/o/r/git/refs/heads/main',
    'gh api repos/o/r/git/refs -F ref=refs/heads/feature',
    'gh api -X DELETE repos/o/r/git/refs/heads/main',
  ])('detects high-severity API ref writes: %s', (command) => {
    expect(redactor.toActivity(output({ command })).policyHits).toEqual([
      { rule: 'push-default-branch', severity: 'high', messageId: 'm1' },
    ]);
  });
  it.each([
    'gh api repos/o/r/pulls/12/merge',
    'gh api -X GET repos/o/r/git/refs/heads/main',
    'gh api repos/o/r/git/refs --method GET -f per_page=10',
    'gh api --method HEAD repos/o/r/pulls/12/merge',
    'gh api -X POST repos/o/r/statuses/abc -f body=repos/o/r/merges',
    'gh api -X POST repos/o/r/statuses/abc --template repos/o/r/merges',
    'gh api -X POST repos/o/r/git/matching-refs',
    'gh pr view 12 --comments',
    'echo "gh pr comment 12 --body hello"',
  ])(
    'does not flag reads, payload paths or unrelated endpoints: %s',
    (command) => {
      expect(redactor.toActivity(output({ command })).policyHits).toEqual([]);
    },
  );
  it('detects PR comments at medium severity', () => {
    expect(
      redactor.toActivity(
        output({ command: 'gh pr comment 12 --body "Please review"' }),
      ).policyHits,
    ).toEqual([{ rule: 'gh-comment', severity: 'medium', messageId: 'm1' }]);
  });
  it.each([
    'git push',
    'git push origin',
    'git push -u origin HEAD',
    'git push --repo=origin',
    'git push origin +HEAD',
    "sh -c 'git push'",
  ])(
    'detects implicit pushes with default or unknown context: %s',
    (command) => {
      for (const options of [
        { defaultBranch: 'main' },
        { defaultBranch: 'main', currentBranch: 'main' },
      ]) {
        expect(
          createRedactor(options).toActivity(output({ command })).policyHits,
        ).toEqual([
          { rule: 'push-default-branch', severity: 'high', messageId: 'm1' },
        ]);
      }
      expect(
        createRedactor({
          defaultBranch: 'main',
          currentBranch: 'feature',
        }).toActivity(output({ command })).policyHits,
      ).toEqual([]);
    },
  );
  it.each([
    'git push origin HEAD:feature',
    'git push origin feature',
    'git push origin refs/heads/feature',
  ])('respects an explicit non-default destination: %s', (command) => {
    expect(
      createRedactor({
        defaultBranch: 'main',
        currentBranch: 'main',
      }).toActivity(output({ command })).policyHits,
    ).toEqual([]);
  });
  it.each([
    'git switch main && git push',
    'git checkout main; git push origin HEAD',
    'cd /other/repo && git push',
    'git -C /other/repo push',
    'GIT_DIR=/other/repo/.git git push',
    'git -c push.default=matching push',
    'git config push.default matching && git push',
    'git push origin :',
    'git push origin HEAD:main',
    'git push origin main',
  ])(
    'does not let feature context hide a possible default-branch push: %s',
    (command) => {
      const contextual = createRedactor({
        defaultBranch: 'main',
        currentBranch: 'feature',
      });
      expect(contextual.toActivity(output({ command })).policyHits).toEqual([
        { rule: 'push-default-branch', severity: 'high', messageId: 'm1' },
      ]);
    },
  );
});

describe('L0 activity', () => {
  it('does not trust summary-shaped raw strings or inherited tool names', () => {
    const input = `<redacted length=999 sha256=${'a'.repeat(64)}>`;
    const item = redactor.toActivity(output(input, 'constructor')).activity[0]!;
    expect(item.category).toBe('other');
    expect(item.tool).toBeUndefined();
    expect(item.inputLen).toBe(Buffer.byteLength(input));
    expect(item.inputHash).toBe(
      createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    );
    ActivityMetaSchema.parse(item);
  });
  it.each([
    ['Read', 'read'],
    ['apply_patch', 'edit'],
    ['Bash', 'shell'],
    ['git', 'git'],
    ['fetch', 'network'],
    ['orca', 'orca'],
    ['secret-custom-tool', 'other'],
  ])('classifies %s', (tool, category) => {
    expect(redactor.toActivity(output({}, tool)).activity[0]?.category).toBe(
      category,
    );
  });
  it('pairs results, counts UTF-8 bytes and hashes input without retaining raw content', () => {
    const input = { command: 'printf "測試 private content"' };
    const event = output(input);
    event.blocks.push({
      type: 'tool_result',
      toolUseId: 't1',
      output: 'private result',
      ok: false,
      durationMs: 12.8,
    });
    const result = redactor.toActivity(event);
    expect(result.activity).toEqual([
      {
        messageId: 'm1',
        tool: 'bash',
        category: 'shell',
        inputLen: Buffer.byteLength(JSON.stringify(input)),
        inputHash: createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex'),
        outputLen: Buffer.byteLength('private result'),
        ok: false,
        durationMs: 12,
      },
    ]);
    result.activity.forEach((item) => ActivityMetaSchema.parse(item));
  });
  it('never exports an eight-character fragment of transcript bodies or unknown tool names', () => {
    const bodies = [
      'Confidential input material 12345678',
      'Distinctive output material ABCDEFGH',
      'Private narrative content 98765432',
      'untrusted-secret-tool-name',
    ];
    const event = output({ command: bodies[0] }, bodies[3]);
    event.blocks.push(
      { type: 'tool_result', toolUseId: 't1', output: bodies[1] },
      { type: 'text', text: bodies[2]! },
    );
    const json = JSON.stringify(redactor.toActivity(event));
    for (const body of bodies)
      for (let i = 0; i <= body.length - 8; i++)
        expect(json).not.toContain(body.slice(i, i + 8));
  });
  it('handles standalone results and text without caching original transcript', () => {
    const event = output(undefined);
    event.blocks = [
      {
        type: 'tool_result',
        toolUseId: 'elsewhere',
        output: 'result',
        ok: true,
      },
      { type: 'text', text: 'message' },
    ];
    expect(redactor.toActivity(event).activity.map((a) => a.outputLen)).toEqual(
      [6, 7],
    );
    expect(redactor.toActivity({ ...event, blocks: [] })).toEqual({
      activity: [],
      policyHits: [],
    });
  });
});

describe('artifact secret masking', () => {
  it('preserves readable artifact bodies and recursively masks secrets without mutation', () => {
    const source = {
      body: 'Keep the conclusion; contact fake@example.com',
      nested: [
        {
          text: 'Seat aio_seat_test12345678',
          token: 'short',
          count: 3,
          empty: null,
        },
      ],
      password: 'tiny',
    };
    const before = structuredClone(source);
    expect(redactor.maskSecrets(source)).toEqual({
      body: 'Keep the conclusion; contact <redacted>',
      nested: [
        { text: 'Seat <redacted>', token: '<redacted>', count: 3, empty: null },
      ],
      password: '<redacted>',
    });
    expect(source).toEqual(before);
  });
  it('uses explicitly configured repository URL preservation', () => {
    const url = 'https://github.com/example/public-test/pull/1';
    expect(redactor.maskSecrets(url)).toBe('<redacted>');
    const configured = createRedactor({
      defaultBranch: 'main',
      preservedRepoUrls: ['https://github.com/example/public-test'],
    });
    expect(configured.maskSecrets(url)).toBe(url);
    expect(
      configured.maskSecrets(
        'https://github.com/example/public-test-other/pull/1',
      ),
    ).toBe('<redacted>');
    expect(configured.maskSecrets(url + '?token=not-public')).not.toContain(
      'not-public',
    );
  });
  it('masks provider tokens and private keys', () => {
    for (const secret of [
      'ghp_fake12345678',
      'sk-ant-fake12345678',
      '-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----',
    ])
      expect(redactor.maskSecrets({ text: secret })).toEqual({
        text: '<redacted>',
      });
  });
  it('rejects key collisions and an empty default branch', () => {
    expect(() =>
      redactor.maskSecrets({ 'one@example.com': 1, 'two@example.com': 2 }),
    ).toThrow('Redacted key collision');
    expect(() => createRedactor({ defaultBranch: '' })).toThrow(
      'Expected a default branch',
    );
  });
});
