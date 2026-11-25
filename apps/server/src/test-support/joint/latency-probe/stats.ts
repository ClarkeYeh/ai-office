/**
 * FX-STATUS-LATENCY live probe: latency of the runtime events the probe
 * recorded (`recordedAt − occurredAt`), split as SPEC §24's realtime row is:
 * state (worker-list `agent.status`) and messages (long-poll mail:
 * `agent.done`, `agent.question`), plus transcript output for reference.
 * Numbers only; event bodies never leave the private event file.
 */
export interface RecordedEvent {
  type: string;
  occurredAt: string;
  recordedAt: string;
}
export interface LagStats {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}
export const STATE_TYPES = ['agent.status'] as const;
export const MESSAGE_TYPES = ['agent.done', 'agent.question'] as const;

const quantile = (sorted: number[], q: number) =>
  sorted[Math.ceil(sorted.length * q) - 1]!;

export function lagStats(
  events: readonly RecordedEvent[],
  types: readonly string[],
): LagStats {
  const lags = events
    .filter((e) => types.includes(e.type))
    .map((e) => Date.parse(e.recordedAt) - Date.parse(e.occurredAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return lags.length === 0
    ? { n: 0, p50: null, p95: null, max: null }
    : {
        n: lags.length,
        p50: quantile(lags, 0.5),
        p95: quantile(lags, 0.95),
        max: lags.at(-1)!,
      };
}

/** The probe's verdicts: SPEC §24 state and messages p95 < 3 s, worst < 5 s. */
export function probeVerdict(events: readonly RecordedEvent[]) {
  const state = lagStats(events, STATE_TYPES);
  const messages = lagStats(events, MESSAGE_TYPES);
  const combined = lagStats(events, [...STATE_TYPES, ...MESSAGE_TYPES]);
  return {
    state,
    messages,
    combined,
    output: lagStats(events, ['agent.output']),
    p95Under3s: combined.p95 !== null && combined.p95 < 3_000,
    worstUnder5s: combined.max !== null && combined.max < 5_000,
  };
}
