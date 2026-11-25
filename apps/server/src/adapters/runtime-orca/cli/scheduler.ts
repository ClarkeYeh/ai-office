import { CwdInventoryExpired, guard } from '../errors.js';
import type { CliPriority } from './types.js';
const order: CliPriority[] = [
  'mutate',
  'consume',
  'worker-list',
  'identity',
  'worker-read',
  'bulk',
];
const CRITICAL: ReadonlySet<CliPriority> = new Set([
  'mutate',
  'consume',
  'worker-list',
]);
/** Calls per minute only the critical lane may use (FX-CLI-BUDGET). */
export const CRITICAL_RESERVE_PER_MINUTE = 40;
interface Job {
  priority: CliPriority;
  start(at: number): void;
  reject(reason: unknown): void;
}
/** One budget for every Orca process, including discovery and long polls. */
export class CliScheduler {
  private starts: number[] = [];
  /** Starts of bulk-lane calls (a subset of `starts`). */
  private bulkStarts: number[] = [];
  private active = 0;
  private queue: Job[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(
    readonly maxCallsPerMinute = 120,
    readonly concurrency = 4,
    private readonly now: () => number = Date.now,
    private readonly onPressure: (pressured: boolean) => void = () => {},
  ) {
    if (
      !Number.isInteger(maxCallsPerMinute) ||
      maxCallsPerMinute < 1 ||
      !Number.isInteger(concurrency) ||
      concurrency < 1
    )
      throw guard('invalid_cli_limits');
  }
  /** The critical reserve, scaled down for small test budgets. */
  private reserve(): number {
    return Math.min(
      CRITICAL_RESERVE_PER_MINUTE,
      Math.floor(this.maxCallsPerMinute / 3),
    );
  }
  callsPerMinute(): number {
    this.starts = this.starts.filter((at) => at > this.now() - 60_000);
    this.bulkStarts = this.bulkStarts.filter((at) => at > this.now() - 60_000);
    return this.starts.length;
  }
  schedule<T>(priority: CliPriority, execute: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(guard('cli_closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        reject,
        start: (at) => {
          void Promise.resolve()
            .then(execute)
            .then(resolve, (error: unknown) => {
              if (error instanceof CwdInventoryExpired) {
                const reserved = this.starts.indexOf(at);
                if (reserved >= 0) this.starts.splice(reserved, 1);
                const bulk = this.bulkStarts.indexOf(at);
                if (bulk >= 0) this.bulkStarts.splice(bulk, 1);
              }
              reject(error);
            })
            .finally(() => {
              this.active--;
              this.drain();
            });
        },
      });
      this.drain();
    });
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const job of this.queue.splice(0)) job.reject(guard('cli_closed'));
  }
  private drain(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const count = this.callsPerMinute();
    this.onPressure(count >= Math.ceil(this.maxCallsPerMinute * 0.8));
    if (this.closed || this.active >= this.concurrency || !this.queue.length)
      return;
    if (count >= this.maxCallsPerMinute) {
      this.timer = setTimeout(
        () => this.drain(),
        Math.max(1, this.starts[0]! + 60_000 - this.now()),
      );
      return;
    }
    this.queue.sort(
      (a, b) => order.indexOf(a.priority) - order.indexOf(b.priority),
    );
    // Priority lane: a bulk call never takes the last slot nor the reserved
    // share of the minute, so the status list, long poll and sends never
    // queue behind reads and probes.
    // The last slot is the status list's alone: a burst of spawns (each
    // worker-start ~4 s) or reads can never hold up a due worker-list.
    const shared = this.active < Math.max(1, this.concurrency - 1);
    const bulkLimit = this.maxCallsPerMinute - this.reserve();
    const index = this.queue.findIndex((job) =>
      job.priority === 'worker-list'
        ? true
        : CRITICAL.has(job.priority)
          ? shared
          : shared && this.bulkStarts.length < bulkLimit,
    );
    if (index < 0) {
      if (this.bulkStarts.length >= bulkLimit)
        this.timer = setTimeout(
          () => this.drain(),
          Math.max(1, this.bulkStarts[0]! + 60_000 - this.now()),
        );
      return;
    }
    const [job] = this.queue.splice(index, 1) as [Job];
    if (!CRITICAL.has(job.priority)) this.bulkStarts.push(this.now());
    this.active++;
    this.starts.push(this.now());
    job.start(this.now());
    this.drain();
  }
}

export class CliMetrics {
  private samples: {
    command: string;
    at: number;
    ms: number;
    failed: boolean;
  }[] = [];
  constructor(
    private readonly now: () => number = Date.now,
    private readonly cpuSecondsPerCall = 0.17,
  ) {}
  record(command: string, ms: number, failed: boolean): void {
    this.samples.push({ command, at: this.now(), ms, failed });
    this.prune();
  }
  private prune(): void {
    this.samples = this.samples.filter((s) => s.at > this.now() - 60_000);
  }
  snapshot() {
    this.prune();
    const commands: Record<
      string,
      { calls: number; p50Ms: number; p95Ms: number; failureRate: number }
    > = {};
    for (const command of new Set(this.samples.map((s) => s.command))) {
      const samples = this.samples.filter((s) => s.command === command);
      const times = samples.map((s) => s.ms).sort((a, b) => a - b);
      commands[command] = {
        calls: times.length,
        p50Ms: times[Math.ceil(times.length * 0.5) - 1]!,
        p95Ms: times[Math.ceil(times.length * 0.95) - 1]!,
        failureRate: samples.filter((s) => s.failed).length / times.length,
      };
    }
    return {
      commands,
      completedCallsPerMinute: this.samples.length,
      cpuSecondsPerMinute: this.samples.length * this.cpuSecondsPerCall,
    };
  }
}
