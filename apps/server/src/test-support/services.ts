import { createHash } from 'node:crypto';
import type { RawAgentOutput } from '../ports/runtime-events.js';
import { AIO_NAMESPACE } from '../ports/services.js';
import type {
  Clock,
  IdGen,
  Logger,
  LogBindings,
  Redactor,
  ScheduledTimer,
  Scheduler,
} from '../ports/services.js';
export class FakeClock implements Clock {
  private timestamp: number;
  constructor(initial = '2026-01-01T00:00:00.000Z') {
    this.timestamp = Date.parse(initial);
    if (!Number.isFinite(this.timestamp)) throw new RangeError('Invalid time');
  }
  now(): Date {
    return new Date(this.timestamp);
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid advance');
    this.timestamp += ms;
  }
}
export class ManualScheduler implements Scheduler {
  private timers = new Map<string, ScheduledTimer>();
  constructor(
    private clock: Clock,
    private onFire: (timer: ScheduledTimer) => void,
  ) {}
  schedule(timer: ScheduledTimer): void {
    if (!Number.isFinite(Date.parse(timer.fireAt)))
      throw new RangeError('Invalid fireAt');
    this.timers.set(timer.id, { ...timer });
  }
  cancel(id: string): void {
    this.timers.delete(id);
  }
  /** Explicitly flush due timers after advancing FakeClock; callback may schedule more. */
  runDue(): void {
    const due = [...this.timers.values()]
      .filter((t) => Date.parse(t.fireAt) <= this.clock.now().getTime())
      .sort(
        (a, b) =>
          Date.parse(a.fireAt) - Date.parse(b.fireAt) ||
          a.id.localeCompare(b.id),
      );
    for (const timer of due) {
      if (this.timers.get(timer.id) !== timer) continue;
      this.timers.delete(timer.id);
      this.onFire({ ...timer });
    }
  }
}
export class SeqIdGen implements IdGen {
  private seq = 0;
  ulid(): string {
    return (++this.seq)
      .toString(32)
      .split('')
      .map((c) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[parseInt(c, 32)])
      .join('')
      .padStart(26, '0');
  }
  shortId(): string {
    return (++this.seq).toString(36).padStart(8, '0');
  }
  orcaRequestId(commandId: string): string {
    const bytes = createHash('sha1')
      .update(Buffer.from(AIO_NAMESPACE.replaceAll('-', ''), 'hex'))
      .update(commandId)
      .digest()
      .subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 15) | 80;
    bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
export type LogEntry = {
  level: 'info' | 'warn' | 'error';
  bindings: LogBindings;
  obj: object;
  msg?: string;
};
export class MemoryLogger implements Logger {
  constructor(
    readonly entries: LogEntry[] = [],
    private bindings: LogBindings = {},
  ) {}
  child(bindings: LogBindings): MemoryLogger {
    return new MemoryLogger(
      this.entries,
      structuredClone({ ...this.bindings, ...bindings }),
    );
  }
  private log(level: LogEntry['level'], obj: object, msg?: string): void {
    this.entries.push(
      structuredClone({
        level,
        bindings: this.bindings,
        obj,
        ...(msg === undefined ? {} : { msg }),
      }),
    );
  }
  info(obj: object, msg?: string): void {
    this.log('info', obj, msg);
  }
  warn(obj: object, msg?: string): void {
    this.log('warn', obj, msg);
  }
  error(obj: object, msg?: string): void {
    this.log('error', obj, msg);
  }
}
/** Test-only: intentionally no masking or policy detection; never wire into production. */
export class PassthroughRedactor implements Redactor {
  toActivity(output: RawAgentOutput): ReturnType<Redactor['toActivity']> {
    void output;
    return { activity: [], policyHits: [] };
  }
  maskSecrets<T>(value: T): T {
    return value;
  }
}
