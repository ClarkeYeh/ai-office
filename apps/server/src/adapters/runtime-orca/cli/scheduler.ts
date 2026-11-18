import { guard } from '../errors.js';
import type { CliPriority } from './types.js';
const order: CliPriority[] = [
  'mutate',
  'consume',
  'identity',
  'worker-list',
  'worker-read',
];
interface Job {
  priority: CliPriority;
  start(): void;
  reject(reason: unknown): void;
}
/** One budget for every Orca process, including discovery and long polls. */
export class CliScheduler {
  private starts: number[] = [];
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
  callsPerMinute(): number {
    this.starts = this.starts.filter((at) => at > this.now() - 60_000);
    return this.starts.length;
  }
  schedule<T>(priority: CliPriority, execute: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(guard('cli_closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        reject,
        start: () => {
          void Promise.resolve()
            .then(execute)
            .then(resolve, reject)
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
    const job = this.queue.shift()!;
    this.active++;
    this.starts.push(this.now());
    job.start();
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
