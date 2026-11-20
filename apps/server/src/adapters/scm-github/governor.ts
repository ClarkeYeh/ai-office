import type { Clock } from '../../ports/services.js';
import { rateLimited, type GithubError } from './errors.js';
export type RequestClass = 'read' | 'write';
type Block = { until: number; code: string };
const unsigned = (value: string | null): number | undefined =>
  value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
export class GithubGovernor {
  private readers = 0;
  private readQueue: (() => void)[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private lastWrite = -Infinity;
  private creations: number[] = [];
  private blocks: Partial<Record<RequestClass, Block>> = {};
  private secondaryCount = 0;
  private remaining: number | undefined;
  private resetAt: number | undefined;
  private clockOffsetMs = 0;
  constructor(
    private clock: Clock,
    private sleep: (ms: number) => Promise<void>,
  ) {}
  private now() {
    return this.clock.now().getTime();
  }
  private check(kind: RequestClass): void {
    const block = this.blocks[kind];
    if (block && block.until > this.now())
      throw rateLimited(block.code, block.until - this.now());
  }
  private block(kind: RequestClass, code: string, delay: number): void {
    const until = this.now() + delay;
    // Concurrent responses must never shorten a cooldown already in effect.
    if (until > (this.blocks[kind]?.until ?? 0))
      this.blocks[kind] = { code, until };
  }
  private resetDelay(): number {
    return Math.max(
      1000,
      this.resetAt === undefined
        ? 60_000
        : this.resetAt - (this.now() + this.clockOffsetMs),
    );
  }
  async run<T>(
    kind: RequestClass,
    content: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.check(kind);
    if (kind === 'read') {
      if (this.readers >= 4)
        await new Promise<void>((resolve) => this.readQueue.push(resolve));
      else this.readers++;
      try {
        this.check(kind);
        return await operation();
      } finally {
        const next = this.readQueue.shift();
        if (next) next();
        else this.readers--;
      }
    }
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      this.check(kind);
      while (true) {
        const now = this.now();
        this.creations = this.creations.filter((at) => at > now - 60_000);
        const wait = Math.max(
          0,
          this.lastWrite + 1000 - now,
          content && this.creations.length >= 20
            ? this.creations[0]! + 60_000 - now
            : 0,
        );
        if (!wait) break;
        await this.sleep(wait);
        this.check(kind);
      }
      this.lastWrite = this.now();
      if (content) this.creations.push(this.now());
      return await operation();
    } finally {
      release();
    }
  }
  observe(headers: Headers): void {
    const remaining = unsigned(headers.get('x-ratelimit-remaining'));
    const seconds = unsigned(headers.get('x-ratelimit-reset'));
    const reset =
      seconds !== undefined && Number.isSafeInteger(seconds * 1000)
        ? seconds * 1000
        : undefined;
    const date = Date.parse(headers.get('date') ?? '');
    if (Number.isFinite(date)) this.clockOffsetMs = date - this.now();
    const serverNow = this.now() + this.clockOffsetMs;
    // Ignore a delayed response from a retired window. Within an active window,
    // interleaved GitHub counters can increase remaining or shift the reset: use
    // the conservative minimum and latest reset until that window expires.
    if (
      reset !== undefined &&
      this.resetAt !== undefined &&
      reset < this.resetAt &&
      reset <= serverNow
    )
      return;
    const freshWindow =
      reset !== undefined &&
      (this.resetAt === undefined ||
        (serverNow >= this.resetAt && reset > this.resetAt));
    if (remaining !== undefined)
      this.remaining =
        freshWindow || this.remaining === undefined
          ? remaining
          : Math.min(this.remaining, remaining);
    if (reset !== undefined)
      this.resetAt = Math.max(this.resetAt ?? reset, reset);
    // A successful last-budget response can exhaust quota without a 403/429.
    if (remaining === 0) {
      this.block('read', 'primary_rate_limit', this.resetDelay());
      this.block('write', 'primary_rate_limit', this.resetDelay());
    }
  }
  success(): void {
    this.secondaryCount = 0;
  }
  private retryDelay(headers: Headers): number | undefined {
    const retry = headers.get('retry-after');
    const parsed =
      retry !== null && /^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry ?? '') - (this.now() + this.clockOffsetMs);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  failure(
    status: number,
    headers: Headers,
    message: string,
    kind: RequestClass,
  ): GithubError | undefined {
    if (status !== 403 && status !== 429) return;
    let code: string, delay: number;
    if (headers.get('x-ratelimit-remaining') === '0') {
      code = 'primary_rate_limit';
      delay = Math.max(this.resetDelay(), this.retryDelay(headers) ?? 0);
    } else if (
      status === 429 ||
      headers.has('retry-after') ||
      /secondary rate limit|abuse detection/i.test(message)
    ) {
      code = 'secondary_rate_limit';
      delay =
        this.retryDelay(headers) ??
        Math.min(900_000, 60_000 * 2 ** Math.min(this.secondaryCount++, 4));
    } else return;
    this.block(kind, code, delay);
    if (code === 'primary_rate_limit') {
      this.block('read', code, delay);
      this.block('write', code, delay);
    }
    const blocked = this.blocks[kind];
    return rateLimited(
      blocked?.code ?? code,
      Math.max(delay, (blocked?.until ?? 0) - this.now()),
    );
  }
  snapshot() {
    const now = this.now();
    const blocks = Object.values(this.blocks).filter((b) => b.until > now);
    const retryAfterMs = Math.max(0, ...blocks.map((b) => b.until - now));
    return {
      remaining: this.remaining,
      resetAt:
        this.resetAt === undefined
          ? undefined
          : this.resetAt - this.clockOffsetMs,
      clockOffsetMs: this.clockOffsetMs,
      retryAfterMs,
      status:
        retryAfterMs > 0 ||
        (this.remaining !== undefined && this.remaining < 200)
          ? ('degraded' as const)
          : ('healthy' as const),
      pollIntervalMs:
        this.remaining !== undefined && this.remaining < 1000 ? 60_000 : 15_000,
      criticalReadsOnly: this.remaining !== undefined && this.remaining < 200,
      warnings: blocks.length
        ? [
            'rate_limited',
            ...(blocks.some((b) => b.code === 'secondary_rate_limit')
              ? ['secondary_rate_limited']
              : []),
          ]
        : this.remaining !== undefined && this.remaining < 1000
          ? ['rate_limit_low']
          : [],
    };
  }
}
