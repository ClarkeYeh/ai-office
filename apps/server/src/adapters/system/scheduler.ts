import type { Clock, ScheduledTimer, Scheduler } from '../../ports/services.js';
import { SystemClock } from './identity.js';

/** Delivery is synchronous: the sink should enqueue into the workflow runner. */
export class TimerScheduler implements Scheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly sink: (timer: ScheduledTimer) => void,
    private readonly clock: Clock = new SystemClock(),
  ) {}
  schedule(timer: ScheduledTimer): void {
    const deadline = Date.parse(timer.fireAt);
    if (!Number.isFinite(deadline)) throw new RangeError('Invalid fireAt');
    const snapshot = { ...timer };
    this.cancel(timer.id);
    const arm = () => {
      // Node clamps overflowing delays to 1 ms; re-arm long timers in bounded chunks.
      const delay = Math.max(
        0,
        Math.min(2 ** 31 - 1, deadline - this.clock.now().getTime()),
      );
      const handle = setTimeout(() => {
        if (this.timers.get(snapshot.id) !== handle) return;
        if (this.clock.now().getTime() < deadline) {
          arm();
          return;
        }
        this.timers.delete(snapshot.id);
        this.sink(snapshot);
      }, delay);
      this.timers.set(snapshot.id, handle);
    };
    arm();
  }
  cancel(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) clearTimeout(handle);
    this.timers.delete(id);
  }
  close(): void {
    for (const id of this.timers.keys()) this.cancel(id);
  }
}
