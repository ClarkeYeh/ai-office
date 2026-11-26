import { describe, expect, it } from 'vitest';
import { lagStats, probeVerdict, type RecordedEvent } from './stats.js';

const at = (ms: number) => new Date(Date.UTC(2026, 10, 26) + ms).toISOString();
const ev = (type: string, lagMs: number, t = 0): RecordedEvent => ({
  type,
  occurredAt: at(t),
  recordedAt: at(t + lagMs),
});

describe('latency probe stats', () => {
  it('splits state and messages as SPEC §24 does, with p50/p95/max', () => {
    const events = [
      ...Array.from({ length: 19 }, (_, i) =>
        ev('agent.status', 100 * (i + 1)),
      ),
      ev('agent.status', 4_000),
      ev('agent.done', 800),
      ev('agent.question', 1_200),
      ev('agent.output', 9_000),
    ];
    expect(lagStats(events, ['agent.status'])).toEqual({
      n: 20,
      p50: 1_000,
      p95: 1_900,
      max: 4_000,
    });
    const verdict = probeVerdict(events);
    expect(verdict.messages).toEqual({
      n: 2,
      p50: 800,
      p95: 1_200,
      max: 1_200,
    });
    expect(verdict.output.max).toBe(9_000);
    expect(verdict.p95Under3s).toBe(true);
    expect(verdict.worstUnder5s).toBe(true);
  });
  it('fails closed with no samples, and on a slow tail', () => {
    expect(probeVerdict([]).p95Under3s).toBe(false);
    const slow = probeVerdict(
      Array.from({ length: 10 }, () => ev('agent.status', 3_500)),
    );
    expect(slow.p95Under3s).toBe(false);
    expect(slow.worstUnder5s).toBe(true);
  });
});
