import { RawAgentOutputSchema } from '../../ports/runtime-events.js';
import { expect, test } from 'vitest';
import { policyRules } from './policy.js';
import { createRedactor } from './index.js';

test.each([
  'ai-office open --print',
  '/opt/bin/ai-office open',
  'env AI_OFFICE_HOME=/tmp/example ai-office open',
  'node /opt/ai-office/apps/cli/dist/main.js open --no-open',
  'bash -lc "ai-office open"',
  'cat /tmp/example/data/control.token',
  'head -c 100 /tmp/example/data/control.token',
  'cat < /tmp/example/data/control.token',
  'grep pattern /tmp/example/data/control.token',
  'rg -e pattern /tmp/example/data/control.token',
])('detects an executed control command or read: %s', (source) => {
  expect([...policyRules(source, 'main')]).toContain('aio-open');
});

test.each([
  'rg "ai-office open" guide',
  'grep -R "ai-office open" .',
  'echo "ai-office open"',
  "cat <<'EOF'\nai-office open\nnode /opt/apps/cli/dist/main.js open\ncat /tmp/data/control.token\nEOF\n",
  'cat <<EOF\nai-office open\nEOF\n',
  'cat <<-EOF\n\tai-office open\n\tEOF\n',
  'node /tmp/example.js open',
  'ai-office submit answer-question',
  'cat /tmp/data/control.token.example',
  'grep control.token guide.md',
  'grep /tmp/example/data/control.token guide.md',
  "sed 's/example//tmp/data/control.token' guide.md",
])('ignores documentation mentions: %s', (source) => {
  expect([...policyRules(source, 'main')]).not.toContain('aio-open');
});

test('detects the command after a heredoc and a structured file read with high severity', () => {
  expect([
    ...policyRules("cat <<'EOF'\nexample\nEOF\nai-office open", 'main'),
  ]).toContain('aio-open');
  const output = createRedactor({ defaultBranch: 'main' }).toActivity(
    RawAgentOutputSchema.parse({
      type: 'agent.output',
      externalKey: 'example',
      agent: 'a1',
      occurredAt: '2026-11-17T00:00:00Z',
      messageId: 'm1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'read_file',
          input: { path: '/tmp/example/data/control.token' },
        },
      ],
    }),
  );
  expect(output.policyHits).toEqual([
    { rule: 'aio-open', severity: 'high', messageId: 'm1' },
  ]);
});
