import { describe, expect, it } from 'vitest';
import { FakeUsage } from './index.js';
import { FakeClock } from '../../test-support/services.js';
const tokens = {
  inputUncached: 10,
  output: 20,
  cacheRead: 1000,
  cacheWrite: 5,
};
const attempt = {
  attemptId: 'attempt',
  agent: 'claude-code' as const,
  dispatchId: 'dispatch',
  reportedSessionId: 'session',
};
describe('FakeUsage', () => {
  it('emits per-message Claude samples, deduplicates message IDs and replays cursors', async () => {
    const clock = new FakeClock(),
      usage = new FakeUsage({ clock });
    const ref = usage.registerAttempt(attempt);
    usage.append(attempt.attemptId, tokens, 'one');
    usage.append(attempt.attemptId, tokens, 'one');
    const first = await usage.read(ref, null);
    expect(first.samples).toEqual([
      {
        ...tokens,
        externalKey: 'usage:session:one',
        cumulative: false,
        occurredAt: clock.now().toISOString(),
      },
    ]);
    expect(await usage.read(ref, null)).toEqual(first);
    expect((await usage.read(ref, first.cursor)).samples).toEqual([]);
    clock.advance(1000);
    usage.append(attempt.attemptId, tokens, 'two');
    expect((await usage.read(ref, first.cursor)).samples).toEqual([
      expect.objectContaining({ externalKey: 'usage:session:two' }),
    ]);
    first.samples[0]!.output = 999;
    expect((await usage.read(ref, null)).samples[0]!.output).toBe(20);
  });
  it('returns the latest cumulative Codex total with a stable key', async () => {
    const usage = new FakeUsage();
    const ref = usage.registerAttempt({ ...attempt, agent: 'codex' });
    usage.append(attempt.attemptId, tokens);
    const first = await usage.read(ref, null);
    usage.append(attempt.attemptId, {
      ...tokens,
      inputUncached: 50,
      output: 80,
      reasoning: 30,
    });
    usage.append(attempt.attemptId, {
      ...tokens,
      inputUncached: 60,
      output: 90,
      reasoning: 35,
    });
    const next = await usage.read(ref, first.cursor);
    expect(next.samples).toEqual([
      {
        ...tokens,
        inputUncached: 60,
        output: 90,
        reasoning: 35,
        externalKey: 'usage:session:cumulative',
        cumulative: true,
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect((await usage.read(ref, next.cursor)).samples).toEqual([]);
  });
  it('locates by session, dispatch or transcript IDs, scoped to attempt and agent', async () => {
    const usage = new FakeUsage();
    const ref = usage.registerAttempt({
      ...attempt,
      transcriptMessageIds: ['message'],
    });
    expect(await usage.locate({ ...attempt, dispatchId: 'wrong' })).toEqual(
      ref,
    );
    expect(
      await usage.locate({ ...attempt, reportedSessionId: 'wrong' }),
    ).toEqual(ref);
    expect(
      await usage.locate({
        ...attempt,
        reportedSessionId: 'wrong',
        dispatchId: 'wrong',
        transcriptMessageIds: ['message'],
      }),
    ).toEqual(ref);
    expect(
      await usage.locate({
        ...attempt,
        reportedSessionId: 'wrong',
        dispatchId: 'wrong',
      }),
    ).toBeNull();
    expect(await usage.locate({ ...attempt, agent: 'codex' })).toBeNull();
    expect(await usage.locate({ ...attempt, attemptId: 'unknown' })).toBeNull();
  });
  it('switches to unavailable without consuming samples and resumes', async () => {
    const usage = new FakeUsage({ source: 'none' });
    const ref = usage.registerAttempt(attempt);
    usage.append(attempt.attemptId, tokens);
    expect(usage.capabilities()).toEqual({
      source: 'none',
      agents: [],
      formatVerified: false,
    });
    expect(await usage.locate(attempt)).toBeNull();
    const unavailable = await usage.read(ref, null);
    expect(unavailable.samples).toEqual([]);
    usage.setSource('session-log');
    expect(usage.capabilities().agents).toEqual(['claude-code', 'codex']);
    expect((await usage.read(ref, unavailable.cursor)).samples).toHaveLength(1);
  });
  it('isolates attempts and rejects invalid samples and references', async () => {
    const usage = new FakeUsage(),
      ref = usage.registerAttempt(attempt);
    const other = usage.registerAttempt({
      attemptId: 'other',
      agent: 'codex',
      dispatchId: 'other',
    });
    usage.append(attempt.attemptId, tokens);
    expect((await usage.read(other, null)).samples).toEqual([]);
    const first = await usage.read(ref, null);
    await expect(usage.read(other, first.cursor)).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(
      usage.read({ ...ref, sessionId: 'wrong' }, null),
    ).rejects.toMatchObject({ code: 'usage_not_found' });
    expect(() => usage.append('missing', tokens)).toThrow();
    expect(() =>
      usage.append(attempt.attemptId, { ...tokens, output: -1 }),
    ).toThrow();
    expect(() => usage.registerAttempt(attempt)).toThrow();
  });
});
