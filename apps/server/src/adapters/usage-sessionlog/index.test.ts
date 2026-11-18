import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { UsageLocateRef, UsageRef } from '../../ports/usage.js';
import { UsageCursorSchema } from '../../ports/refs.js';
import { createSessionLogUsage } from './index.js';

let home: string;
let now: number;
const fixture = async (name: string): Promise<unknown[]> =>
  JSON.parse(
    await readFile(
      new URL(`../../../../../fixtures/usage/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as unknown[];
const jsonl = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const query = (extra: Partial<UsageLocateRef> = {}): UsageLocateRef => ({
  attemptId: 'attempt-1',
  agent: 'claude-code',
  dispatchId: 'dispatch-1',
  startedAt: new Date(now - 60_000).toISOString(),
  ...extra,
});
async function file(path: string, contents: string, modified = now) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  await utimes(path, modified / 1000, modified / 1000);
  return path;
}
const adapter = () =>
  createSessionLogUsage({ homeDir: home, clock: { now: () => new Date(now) } });
const claudePath = (id = 'session-1', root = join(home, '.claude')) =>
  join(root, 'projects', '-test', `${id}.jsonl`);
const codexPath = (id = 'thread-1', root = join(home, '.codex')) =>
  join(root, 'sessions', '2026', '01', '01', `rollout-2026-01-01-${id}.jsonl`);
const ref = (
  path: string,
  agent: UsageRef['agent'] = 'claude-code',
): UsageRef => ({
  attemptId: 'attempt-1',
  agent,
  sessionId: agent === 'codex' ? 'thread-1' : 'session-1',
  file: path,
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aio-usage-'));
  now = Date.parse('2026-01-01T01:00:00Z');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('session usage parsing', () => {
  it('takes the last Claude line per id and retains interrupted usage across restart until 30 seconds idle', async () => {
    const path = await file(claudePath(), jsonl(await fixture('claude')));
    const first = await adapter().read(ref(path), null);
    expect(first.samples).toEqual([
      {
        externalKey: 'usage:session-1:message-1',
        occurredAt: '2026-01-01T00:00:01Z',
        inputUncached: 10,
        output: 8,
        cacheRead: 100,
        cacheWrite: 20,
        cumulative: false,
      },
    ]);
    expect(JSON.parse(first.cursor).offset).toBe(
      (await readFile(path)).byteLength,
    );
    now += 29_999;
    expect((await adapter().read(ref(path), first.cursor)).samples).toEqual([]);
    now += 1;
    const second = await adapter().read(ref(path), first.cursor);
    expect(second.samples).toMatchObject([
      { externalKey: 'usage:session-1:message-2', output: 7 },
    ]);
    expect((await adapter().read(ref(path), second.cursor)).samples).toEqual(
      [],
    );
    expect((await adapter().read(ref(path), first.cursor)).samples).toEqual(
      second.samples,
    );
  });
  it('waits for the last streaming line across polls, and closes on a new message', async () => {
    const rows = await fixture('claude');
    const path = await file(claudePath(), jsonl([rows[0]]));
    const usage = adapter();
    const first = await usage.read(ref(path), null);
    expect(first.samples).toEqual([]);
    await appendFile(
      path,
      jsonl([rows[1], rows[2], rows[3], { type: 'user' }]),
    );
    const second = await usage.read(ref(path), first.cursor);
    expect(second.samples.map((s) => s.output)).toEqual([8, 7]);
  });
  it('finalizes an interrupted message when another assistant id arrives', async () => {
    const rows = await fixture('claude');
    const path = await file(claudePath(), jsonl([rows[0], rows[2]]));
    expect(
      (await adapter().read(ref(path), null)).samples.map((s) => s.output),
    ).toEqual([2]);
  });
  it('returns normalized Codex cumulative samples for application-side delta accounting', async () => {
    const path = await file(codexPath(), jsonl(await fixture('codex')));
    const result = await adapter().read(ref(path, 'codex'), null);
    expect(result.samples).toEqual([
      {
        externalKey: 'usage:codex:thread-1:120',
        occurredAt: '2026-01-01T00:00:01Z',
        inputUncached: 40,
        output: 20,
        cacheRead: 60,
        cacheWrite: 0,
        reasoning: 10,
        cumulative: true,
      },
      {
        externalKey: 'usage:codex:thread-1:180',
        occurredAt: '2026-01-01T00:00:02Z',
        inputUncached: 70,
        output: 30,
        cacheRead: 80,
        cacheWrite: 0,
        reasoning: 15,
        cumulative: true,
      },
    ]);
    expect(
      (await adapter().read(ref(path, 'codex'), result.cursor)).samples,
    ).toEqual([]);
  });
  it('uses byte offsets with UTF-8, waits for partial writes, and never retains transcript content', async () => {
    const rows = await fixture('claude');
    const ignored = { type: 'user', content: 'synthetic 私密 text' };
    const complete = jsonl([ignored, rows[0]]);
    const final = JSON.stringify(rows[1]);
    const path = await file(claudePath(), complete + final.slice(0, 50));
    const usage = adapter();
    const first = await usage.read(ref(path), null);
    expect(JSON.parse(first.cursor).offset).toBe(Buffer.byteLength(complete));
    expect(first.cursor).not.toContain('synthetic');
    expect(first.samples).toEqual([]);
    await appendFile(path, final.slice(50) + '\n');
    const second = await usage.read(ref(path), first.cursor);
    expect(second.samples).toHaveLength(1);
    expect(second.samples[0]?.output).toBe(8);
  });
  it('reads an idle final record without newline', async () => {
    const rows = await fixture('claude');
    const path = await file(
      claudePath(),
      JSON.stringify(rows[1]),
      now - 30_000,
    );
    expect((await adapter().read(ref(path), null)).samples).toHaveLength(1);
  });
  it('degrades without leaking parse errors and recovers with the retained cursor', async () => {
    const usage = adapter();
    const path = await file(
      claudePath(),
      'synthetic private malformed input\n',
    );
    await expect(usage.read(ref(path), null)).rejects.toMatchObject({
      code: 'usage_unavailable',
      message: 'Session usage unavailable',
    });
    expect(usage.capabilities()).toMatchObject({
      source: 'none',
      formatVerified: false,
    });
    await file(path, jsonl(await fixture('claude')));
    expect((await usage.read(ref(path), null)).samples).toHaveLength(1);
    expect(usage.capabilities()).toMatchObject({
      source: 'session-log',
      formatVerified: true,
    });
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '10', null])(
    'rejects invalid counters (%s)',
    async (value) => {
      const path = await file(
        claudePath(),
        jsonl([
          {
            type: 'assistant',
            timestamp: '2026-01-01T00:00:00Z',
            message: {
              id: 'm',
              stop_reason: 'end_turn',
              usage: { input_tokens: value, output_tokens: 1 },
            },
          },
        ]),
      );
      await expect(adapter().read(ref(path), null)).rejects.toMatchObject({
        code: 'usage_unavailable',
      });
    },
  );
  it('rejects invalid cached input, total or reasoning counters', async () => {
    for (const change of [
      { cached_input_tokens: 101 },
      { total_tokens: 121 },
      { reasoning_output_tokens: 21 },
    ]) {
      const path = await file(
        codexPath(),
        jsonl([
          {
            type: 'event_msg',
            timestamp: '2026-01-01T00:00:00Z',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  cached_input_tokens: 60,
                  output_tokens: 20,
                  total_tokens: 120,
                  ...change,
                },
              },
            },
          },
        ]),
      );
      await expect(
        adapter().read(ref(path, 'codex'), null),
      ).rejects.toMatchObject({ code: 'usage_unavailable' });
    }
  });
  it('rejects malformed, mismatched cursors and truncated files', async () => {
    const usage = adapter();
    const path = await file(claudePath(), jsonl(await fixture('claude')));
    const first = await usage.read(ref(path), null);
    await expect(
      usage.read(ref(path), UsageCursorSchema.parse('bad')),
    ).rejects.toMatchObject({ code: 'invalid_usage_cursor' });
    await expect(
      usage.read({ ...ref(path), attemptId: 'other' }, first.cursor),
    ).rejects.toMatchObject({ code: 'invalid_usage_cursor' });
    await file(path, '');
    await expect(usage.read(ref(path), first.cursor)).rejects.toMatchObject({
      code: 'usage_unavailable',
    });
  });
});

describe('session discovery', () => {
  it('returns null when missing and never creates provider directories', async () => {
    expect(await adapter().locate(query())).toBeNull();
    await expect(readFile(claudePath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('prioritizes reported session id over dispatch and message matches, independent of age', async () => {
    const reported = await file(claudePath('reported'), '', now - 86_400_001);
    await file(
      claudePath(),
      jsonl([{ type: 'user', dispatch: 'dispatch-1', uuid: 'message-1' }]),
    );
    expect(
      await adapter().locate(
        query({
          reportedSessionId: 'reported',
          transcriptMessageIds: ['message-1'],
        }),
      ),
    ).toMatchObject({ file: reported, sessionId: 'reported' });
  });
  it('prioritizes dispatch matches globally, filters old files, and falls back to exact message ids', async () => {
    await file(
      claudePath('a-old'),
      jsonl([{ type: 'user', dispatch: 'dispatch-1' }]),
      now - 60_001,
    );
    const message = await file(
      claudePath('b-message'),
      jsonl([{ type: 'user', uuid: 'message-1' }]),
    );
    const dispatch = await file(
      claudePath('z-dispatch'),
      jsonl([{ type: 'user', content: 'dispatch-1' }]),
    );
    expect(
      await adapter().locate(query({ transcriptMessageIds: ['message-1'] })),
    ).toMatchObject({ file: dispatch });
    await rm(dispatch);
    expect(
      await adapter().locate(query({ transcriptMessageIds: ['message-1'] })),
    ).toMatchObject({ file: message });
    expect(
      await adapter().locate(query({ transcriptMessageIds: ['message'] })),
    ).toBeNull();
  });
  it('uses configured Claude roots before observed roots before default', async () => {
    const configured = join(home, 'configured');
    const observed = join(home, 'observed');
    const hints = join(
      home,
      'Library',
      'Application Support',
      'orca',
      'claude-observed-config-dirs.json',
    );
    await file(hints, JSON.stringify([observed]));
    const first = await file(claudePath('session-1', configured), '');
    const second = await file(claudePath('session-1', observed), '');
    const third = await file(claudePath(), '');
    const usage = createSessionLogUsage({
      homeDir: home,
      claudeConfigDirs: [configured],
    });
    const q = query({ reportedSessionId: 'session-1' });
    expect((await usage.locate(q))?.file).toBe(first);
    await rm(first);
    expect((await usage.locate(q))?.file).toBe(second);
    await rm(second);
    expect((await usage.locate(q))?.file).toBe(third);
  });
  it('finds Codex in configured, Orca managed, and default homes', async () => {
    const configured = join(home, 'configured');
    const managed = join(
      home,
      'Library',
      'Application Support',
      'orca',
      'codex-runtime-home',
      'home',
    );
    const paths = [
      await file(codexPath('thread-1', configured), ''),
      await file(codexPath('thread-1', managed), ''),
      await file(codexPath(), ''),
    ];
    const usage = createSessionLogUsage({
      homeDir: home,
      codexHomes: [configured],
    });
    for (const expected of paths) {
      expect(
        (
          await usage.locate(
            query({ agent: 'codex', reportedSessionId: 'thread-1' }),
          )
        )?.file,
      ).toBe(expected);
      await rm(expected);
    }
  });
  it('recovers the Codex thread from session metadata when matching the preamble', async () => {
    const path = await file(
      codexPath(),
      jsonl([
        { type: 'session_meta', payload: { id: 'thread-1' } },
        { type: 'response_item', content: 'dispatch-1' },
      ]),
    );
    expect(await adapter().locate(query({ agent: 'codex' }))).toMatchObject({
      file: path,
      sessionId: 'thread-1',
    });
  });
  it('bounds legacy fallback to 24 hours, rejects invalid dates and skips symlinks', async () => {
    const path = await file(
      claudePath(),
      jsonl([{ type: 'user', content: 'dispatch-1' }]),
      now - 86_400_001,
    );
    const legacy = query();
    delete legacy.startedAt;
    expect(await adapter().locate(legacy)).toBeNull();
    expect(await adapter().locate(query({ startedAt: 'invalid' }))).toBeNull();
    await symlink(path, claudePath('linked'));
    expect(
      await adapter().locate(query({ reportedSessionId: 'linked' })),
    ).toBeNull();
  });
});
