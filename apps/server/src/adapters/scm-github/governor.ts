import type { Clock } from '../../ports/services.js';
import { rateLimited, type GithubError } from './errors.js';
export type RequestClass = 'read' | 'write';
type Block = { until: number; code: string };
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
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (
      remaining !== null &&
      /^\d+$/.test(remaining) &&
      Number.isSafeInteger(Number(remaining))
    )
      this.remaining = Number(remaining);
    if (
      reset !== null &&
      /^\d+$/.test(reset) &&
      Number.isSafeInteger(Number(reset) * 1000)
    )
      this.resetAt = Number(reset) * 1000;
    const date = Date.parse(headers.get('date') ?? '');
    if (Number.isFinite(date)) this.clockOffsetMs = date - this.now();
    // A successful last-budget response can exhaust quota without a 403/429.
    if (remaining === '0') {
      this.block('read', 'primary_rate_limit', this.resetDelay());
      this.block('write', 'primary_rate_limit', this.resetDelay());
    }
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
      delay = this.resetDelay();
    } else if (
      status === 429 ||
      headers.has('retry-after') ||
      /secondary rate limit|abuse detection/i.test(message)
    ) {
      code = 'secondary_rate_limit';
      const retry = headers.get('retry-after');
      const parsed =
        retry !== null && /^\d+(?:\.\d+)?$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry ?? '') - this.now();
      delay =
        Number.isFinite(parsed) && parsed >= 0
          ? parsed
          : Math.min(900_000, 60_000 * 2 ** Math.min(this.secondaryCount++, 4));
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
      resetAt: this.resetAt,
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
