/**
 * M5-T7 health sampler (M5_PLAN §2.1): every 30 s reads `/api/v1/health` and
 * keeps numbers only — Orca CLI calls per minute, each adapter's call and
 * failure counts, and the GitHub rate-limit remaining. Calls are counted
 * (not derived from `remaining`), so the hourly quota reset cannot skew them
 * (M3-T17). A failed read during the restart downtime is counted, not fatal.
 */
import type { Api, Json } from '../orca/t17/office.js';

export interface HealthSample {
  at: number;
  cliCallsPerMinute?: number;
  remaining?: number;
  adapters: Record<string, { calls: number; failures: number }>;
}

export interface SamplerSummary {
  samples: number;
  failedReads: number;
  maxCliCallsPerMinute: number;
  /** Max of each adapter's rolling five-minute call count. */
  maxAdapterCalls: Record<string, number>;
  remaining: { first?: number; last?: number; min?: number };
}

/** Pure: one health body → one sample. */
export function toSample(
  health: Json | null | undefined,
  at: number,
): HealthSample {
  const adapters: HealthSample['adapters'] = {};
  for (const a of (health?.adapters ?? []) as Json[])
    if (typeof a?.adapter === 'string')
      adapters[a.adapter] = {
        calls: Number(a.calls ?? 0),
        failures: Number(a.failures ?? 0),
      };
  const cpm = health?.runtime?.cliCallsPerMinute;
  const remaining = health?.scm?.rateLimit?.remaining;
  return {
    at,
    ...(typeof cpm === 'number' ? { cliCallsPerMinute: cpm } : {}),
    ...(typeof remaining === 'number' ? { remaining } : {}),
    adapters,
  };
}

/** Pure: samples → report numbers. */
export function summarize(
  samples: HealthSample[],
  failedReads: number,
): SamplerSummary {
  const maxAdapterCalls: Record<string, number> = {};
  for (const s of samples)
    for (const [name, a] of Object.entries(s.adapters))
      maxAdapterCalls[name] = Math.max(maxAdapterCalls[name] ?? 0, a.calls);
  const remaining = samples
    .map((s) => s.remaining)
    .filter((n): n is number => typeof n === 'number');
  return {
    samples: samples.length,
    failedReads,
    maxCliCallsPerMinute: Math.max(
      0,
      ...samples.map((s) => s.cliCallsPerMinute ?? 0),
    ),
    maxAdapterCalls,
    remaining: remaining.length
      ? {
          first: remaining[0]!,
          last: remaining.at(-1)!,
          min: Math.min(...remaining),
        }
      : {},
  };
}

export class HealthSampler {
  readonly samples: HealthSample[] = [];
  failedReads = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly api: () => Api,
    private readonly options: { intervalMs?: number; now?: () => number } = {},
  ) {}

  async sample(): Promise<void> {
    try {
      const { status, body } = await this.api().call('GET', '/api/v1/health');
      if (status !== 200) throw new Error(String(status));
      this.samples.push(toSample(body, (this.options.now ?? Date.now)()));
    } catch {
      this.failedReads++;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(
      () => void this.sample(),
      this.options.intervalMs ?? 30_000,
    );
    this.timer.unref();
  }

  stop(): SamplerSummary {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return summarize(this.samples, this.failedReads);
  }
}
