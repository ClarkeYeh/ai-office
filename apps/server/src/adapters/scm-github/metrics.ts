import type { Clock } from '../../ports/services.js';
import type { EndpointId } from './policy/endpoints.js';
type Sample = { at: number; latency: number; status: number; failed: boolean };
export class GithubMetrics {
  private samples = new Map<EndpointId, Sample[]>();
  constructor(private clock: Clock) {}
  record(
    id: EndpointId,
    latency: number,
    status: number,
    failed: boolean,
  ): void {
    const samples = this.recent(id);
    samples.push({ at: this.clock.now().getTime(), latency, status, failed });
    this.samples.set(id, samples.slice(-5000));
  }
  private recent(id: EndpointId) {
    return (this.samples.get(id) ?? []).filter(
      (s) => s.at > this.clock.now().getTime() - 300_000,
    );
  }
  snapshot() {
    return Object.fromEntries(
      [...this.samples.keys()].map((id) => {
        const samples = this.recent(id),
          sorted = samples.map((s) => s.latency).sort((a, b) => a - b);
        const percentile = (p: number) =>
          sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
        return [
          id,
          {
            calls: samples.length,
            notModifiedRatio:
              samples.filter((s) => s.status === 304).length /
              (samples.length || 1),
            failureRate:
              samples.filter((s) => s.failed).length / (samples.length || 1),
            p50: percentile(0.5),
            p95: percentile(0.95),
          },
        ];
      }),
    );
  }
}
