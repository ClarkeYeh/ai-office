import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type {
  DomainEventDraft,
  ErrorCategory,
  EventPayload,
  ExternalCommandKind,
} from '@ai-office/contracts/events';
import type { Clock, ScheduledTimer, Scheduler } from '../../ports/services.js';
import type { EventStore } from '../../ports/stores.js';
import type { ScmHealth } from '../../ports/scm.js';
import type { DomainCommand, WorkflowState } from '@ai-office/domain';
import { PortError } from '../../ports/errors.js';

export interface HealthWorkflow {
  readonly state: WorkflowState;
  dispatch(command: DomainCommand): Promise<unknown>;
}
import { toErrorInfo } from '../commands/errors.js';

export const HEALTH_TIMER_PREFIX = 'aio-health:';
/** A probe still pending after this long counts as a transient failure. */
export const PROBE_TIMEOUT_MS = 5_000;
export const HEALTH_COMPONENTS = ['runtime', 'scm', 'store', 'usage'] as const;
/** AP5: how often the active gh login is compared with ownerLogin (§17.2). */
export const ACTIVE_LOGIN_INTERVAL_MS = 5 * 60_000;
/** How often `scmStatus` (login, rate limit; `GET /rate_limit` is free) is read. */
export const SCM_STATUS_INTERVAL_MS = 60_000;
/**
 * §12.2 slowdown thresholds on `x-ratelimit-remaining`. Each level is left
 * only `RATE_LIMIT_HYSTERESIS` above where it was entered: the primary budget
 * is shared with the owner's own `gh`, so samples jitter around a threshold.
 */
export const RATE_LIMIT_SLOW_BELOW = 1_000;
export const RATE_LIMIT_CRITICAL_BELOW = 200;
export const RATE_LIMIT_HYSTERESIS = 100;
/** The primary limit of a user token (§12.2); ScmHealth reports no limit. */
export const GITHUB_PRIMARY_LIMIT = 5_000;
/**
 * `normal`: §12.2 cadence; `slow`: SCM polls every 60 s; `critical`: poll
 * only the final PR and PRs with a merge in flight, scm `degraded`.
 */
export type ScmPace = 'normal' | 'slow' | 'critical';
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];
/** The breakers a command kind waits for (SPEC §15 S21, M3_PLAN §4.7). */
export const dispatchComponents = (
  kind: ExternalCommandKind,
): readonly HealthComponent[] =>
  kind === 'runtime.stop' || kind === 'runtime.release'
    ? ['runtime']
    : kind.startsWith('scm.')
      ? ['scm', 'store']
      : ['runtime', 'store'];
type Breaker = 'closed' | 'open' | 'half_open';
type Sample = { at: number; duration: number; error?: ErrorCategory };
type Status = 'healthy' | 'degraded' | 'unhealthy';
/** What the event store last said about a component (the projected state). */
type Published = { status: Status; breaker?: Breaker; verified?: boolean };
type ComponentState = {
  breaker: Breaker;
  failures: number[];
  samples: Sample[];
  lastErrorCategory?: ErrorCategory;
  checkedAt?: string;
  probeAt?: number;
};
export interface HealthMonitorDeps {
  clock: Clock;
  scheduler: Scheduler;
  /** Dedicated, read-only probes; never replay a mutation as a probe. */
  probes: Record<HealthComponent, () => Promise<void>>;
  /** Bound on each probe (default PROBE_TIMEOUT_MS); a real timer, not `clock`. */
  probeTimeoutMs?: number;
  /** Uninstrumented store: health publication must not recursively record itself. */
  store: EventStore;
  /** Evaluated lazily to support composition with WorkflowRunners. */
  workflows: () => readonly HealthWorkflow[];
  /**
   * AP5 (T12 injects): resolves whether gh's active login still equals
   * ownerLogin. Checked every ACTIVE_LOGIN_INTERVAL_MS; a mismatch pauses
   * running workflows with `auth` until it matches again. A throw (gh
   * unavailable) leaves the last verdict.
   */
  activeLoginProbe?: () => Promise<boolean>;
  /** The SCM adapter's own report (login, rate limit, token source, warnings). */
  scmStatus?: () => Promise<ScmHealth>;
  /** T10 supplies the Orca adapter callback; absent in fake mode. */
  forceRecheck?: () => Promise<void>;
  /** Monotonic milliseconds, injectable for clock-jump tests. */
  monotonicNow?: () => number;
  runtime: { mode: 'fake' | 'orca'; verified: boolean; version?: string };
}

/** Process-local circuit state and a rolling five-minute observation window.
 * Each real attempt (including retries and probes) is counted once. Success or
 * any non-transient failure breaks the consecutive transient streak.
 */
export class HealthMonitor {
  private readonly states: Record<HealthComponent, ComponentState> = {
    runtime: { breaker: 'closed', failures: [], samples: [] },
    scm: { breaker: 'closed', failures: [], samples: [] },
    store: { breaker: 'closed', failures: [], samples: [] },
    usage: { breaker: 'closed', failures: [], samples: [] },
  };
  private readonly waiters = new Set<() => void>();
  private readonly pending: DomainEventDraft[] = [];
  private syncing: Promise<void> = Promise.resolve();
  /** Seeded lazily from the last persisted `health.changed` per component. */
  private published: Partial<Record<HealthComponent, Published>> | undefined;
  private runtimeVerified: boolean | undefined;
  /** Set by publishInitial; afterwards a successful call republishes `healthy`. */
  private announced = false;

  private readonly scm: {
    login?: string;
    tokenSource?: 'env' | 'gh';
    warnings: readonly string[];
    rateLimit?: { remaining: number; resetAt: string };
    pace: ScmPace;
    limitedUntil?: number;
    limitedCode?: string;
    loginMismatch: boolean;
    /** The last SCM poll's non-transient failure code (`poll_failing`). */
    pollFailure?: string;
  } = { warnings: [], pace: 'normal', loginMismatch: false };
  /** commandId → workflowId of scm commands rate limited past RATE_LIMIT_PAUSE_MS. */
  private readonly scmHolds = new Map<string, string>();
  /** Workflows this monitor paused with `auth` (it resumes only those). */
  private readonly authPaused = new Set<string>();

  private tickAt: number | undefined;
  private lastWall = 0;
  private lastMono = 0;
  private slept = false;
  private stopped = false;

  constructor(private readonly deps: HealthMonitorDeps) {
    if (deps.forceRecheck) this.scheduleTick();
    if (deps.activeLoginProbe)
      this.scheduleAt('login', ACTIVE_LOGIN_INTERVAL_MS);
  }

  private scheduleAt(timer: 'login' | 'scm-status' | 'scm-limit', ms: number) {
    this.deps.scheduler.schedule({
      id: `${HEALTH_TIMER_PREFIX}${timer}`,
      workflowId: '__health__',
      fireAt: new Date(this.deps.clock.now().getTime() + ms).toISOString(),
    });
  }

  private scheduleTick(): void {
    this.lastWall = this.deps.clock.now().getTime();
    this.lastMono = (this.deps.monotonicNow ?? (() => performance.now()))();
    this.tickAt = this.lastWall + 10_000;
    this.deps.scheduler.schedule({
      id: HEALTH_TIMER_PREFIX + 'clock',
      workflowId: '__health__',
      fireAt: new Date(this.tickAt).toISOString(),
    });
  }

  /** Cancel the periodic wake detector during backend shutdown. */
  close(): void {
    this.stopped = true;
    this.tickAt = undefined;
    this.deps.scheduler.cancel(HEALTH_TIMER_PREFIX + 'clock');
    for (const timer of ['login', 'scm-status', 'scm-limit'])
      this.deps.scheduler.cancel(HEALTH_TIMER_PREFIX + timer);
  }

  /** §12.2 slowdown level for the ObservationLoop's SCM cadence. */
  scmPace(): ScmPace {
    return this.rateLimitedNow() ? 'critical' : this.scm.pace;
  }

  /**
   * The executor got `rate_limited` with `retryAfterMs` (§12.2): scm shows
   * `degraded` and a `rate_limited`/`secondary_rate_limited` warning until
   * then. The breaker is untouched.
   */
  async noteRateLimit(code: string, retryAfterMs: number): Promise<void> {
    const until = this.deps.clock.now().getTime() + retryAfterMs;
    if (until > (this.scm.limitedUntil ?? 0)) {
      this.scm.limitedUntil = until;
      this.scm.limitedCode = code;
      this.scheduleAt('scm-limit', retryAfterMs);
    }
    this.publishScm();
    await this.sync();
  }

  /**
   * A workflow's scm command has been rate limited for over five minutes
   * (§12.2): pause it with `scm_unhealthy` until `releaseScm`. Only the
   * workflow's new work stops; runtime commands still run (S21).
   */
  async holdScm(workflowId: string, commandId: string): Promise<void> {
    this.scmHolds.set(commandId, workflowId);
    await this.sync();
  }

  async releaseScm(commandId: string): Promise<void> {
    if (!this.scmHolds.delete(commandId)) return;
    await this.sync();
  }

  private rateLimitedNow(): boolean {
    return (this.scm.limitedUntil ?? 0) > this.deps.clock.now().getTime();
  }

  private async refreshScm(): Promise<void> {
    if (!this.deps.scmStatus) return;
    let status: ScmHealth;
    try {
      status = await this.deps.scmStatus();
    } catch {
      return; // The breaker accounting stays with probes and real calls.
    } finally {
      if (!this.stopped) this.scheduleAt('scm-status', SCM_STATUS_INTERVAL_MS);
    }
    const remaining = Math.max(0, Math.floor(status.rateLimitRemaining));
    const { pace } = this.scm;
    this.scm.pace =
      remaining < RATE_LIMIT_CRITICAL_BELOW ||
      (pace === 'critical' &&
        remaining < RATE_LIMIT_CRITICAL_BELOW + RATE_LIMIT_HYSTERESIS)
        ? 'critical'
        : remaining < RATE_LIMIT_SLOW_BELOW ||
            (pace !== 'normal' &&
              remaining < RATE_LIMIT_SLOW_BELOW + RATE_LIMIT_HYSTERESIS)
          ? 'slow'
          : 'normal';
    this.scm.rateLimit = { remaining, resetAt: status.rateLimitResetAt };
    if (status.viewerLogin === null) delete this.scm.login;
    else this.scm.login = status.viewerLogin;
    if (status.tokenSource === undefined) delete this.scm.tokenSource;
    else this.scm.tokenSource = status.tokenSource;
    this.scm.warnings = status.warnings ?? [];
    this.publishScm();
    await this.sync();
  }

  private async loginTick(): Promise<void> {
    if (this.stopped) return;
    this.scheduleAt('login', ACTIVE_LOGIN_INTERVAL_MS);
    let matches = !this.scm.loginMismatch;
    try {
      await this.bounded('scm', async () => {
        matches = await this.deps.activeLoginProbe!();
      });
    } catch {
      return;
    }
    if (this.scm.loginMismatch === !matches) return;
    this.scm.loginMismatch = !matches;
    this.publishScm();
    await this.sync();
  }

  /**
   * ObservationLoop reports each SCM poll: a non-transient failure (guard,
   * contract_mismatch, …) shows `poll_failing:<code>` and degrades scm until
   * a poll succeeds; it never touches the breaker.
   */
  async noteScmPoll(failureCode: string | undefined): Promise<void> {
    if (this.scm.pollFailure === failureCode) return;
    if (failureCode === undefined) delete this.scm.pollFailure;
    else this.scm.pollFailure = failureCode;
    this.publishScm();
    await this.sync();
  }

  /** SCM warnings for HealthView (M3_PLAN §8.6), adapter ones first. */
  private scmWarnings(): string[] {
    const warnings = new Set(this.scm.warnings);
    if (this.scm.pace !== 'normal') warnings.add('rate_limit_low');
    if (this.rateLimitedNow())
      warnings.add(
        this.scm.limitedCode === 'secondary_rate_limit'
          ? 'secondary_rate_limited'
          : 'rate_limited',
      );
    if (this.scm.loginMismatch) warnings.add('active_account_mismatch');
    if (this.scm.pollFailure !== undefined)
      warnings.add(`poll_failing:${this.scm.pollFailure}`);
    return [...warnings];
  }

  /** Republish scm when its degraded state changed (after publishInitial). */
  private publishScm(): void {
    if (this.announced) this.publish('scm', this.status('scm'));
  }

  private async clockTick(timer: ScheduledTimer): Promise<void> {
    if (
      this.stopped ||
      this.tickAt === undefined ||
      Date.parse(timer.fireAt) !== this.tickAt
    )
      return;
    const now = this.deps.clock.now().getTime();
    const mono = (this.deps.monotonicNow ?? (() => performance.now()))();
    const jump = Math.abs(now - this.lastWall - (mono - this.lastMono));
    const late = now - this.tickAt;
    // Rebase before awaiting IO so duplicate deliveries cannot recheck twice.
    this.scheduleTick();
    if (jump <= 30_000 && late <= 30_000) return;
    this.slept = true;
    this.pending.push({
      type: 'health.changed',
      payload: {
        component: 'runtime',
        breaker: this.states.runtime.breaker,
        status: this.status('runtime'),
        detail: 'host_slept',
      },
      workflowId: null,
      occurredAt: new Date(now).toISOString(),
      source: 'system',
      provenance: 'observed',
      schemaVersion: CURRENT_SCHEMA_VERSION['health.changed'],
    });
    await this.sync();
    try {
      await this.call('runtime', () =>
        this.bounded('runtime', this.deps.forceRecheck!),
      );
    } catch {
      /* Normal health accounting; never respawn workers. */
    }
  }

  /** After runner recovery, retain persisted unhealthy pauses until a fresh probe. */
  async restore(): Promise<void> {
    for (const component of ['runtime', 'scm', 'store'] as const) {
      const reason = `${component}_unhealthy` as const;
      if (
        this.states[component].breaker === 'closed' &&
        this.deps
          .workflows()
          .some(
            (runner) =>
              runner.state.workflow?.status === 'running' &&
              runner.state.workflow.pausedReasons.includes(reason),
          )
      )
        this.change(component, 'open');
    }
    await this.sync();
  }

  /** Any dispatch-relevant breaker is not closed (the overall health status). */
  get dispatchBlocked(): boolean {
    return HEALTH_COMPONENTS.some(
      (c) => c !== 'usage' && this.states[c].breaker !== 'closed',
    );
  }

  /**
   * Per-component dispatch blocking (SPEC §15, S21): a command waits only for
   * the breakers it depends on, so a GitHub outage never holds a stop or a
   * release.
   */
  dispatchBlockedFor(kind: ExternalCommandKind): boolean {
    return dispatchComponents(kind).some(
      (c) => this.states[c].breaker !== 'closed',
    );
  }

  /** Called before every executor attempt, including attempts queued during an outage. */
  async waitUntilDispatchable(kind: ExternalCommandKind): Promise<void> {
    await this.sync();
    while (this.dispatchBlockedFor(kind)) {
      // StartWorkflow registers its runner after its initial events drain.
      // Resync after yielding so a newly started workflow is paused as well.
      await this.sync();
      if (this.dispatchBlockedFor(kind))
        await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** Observe adapter calls outside the executor (including synchronous stores). */
  async call<T>(
    component: HealthComponent,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const started = this.deps.clock.now().getTime();
    try {
      const result = await operation();
      await this.record(component, started);
      return result;
    } catch (error) {
      await this.record(component, started, toErrorInfo(error).category);
      throw error;
    }
  }

  /**
   * `waitStated`: the adapter answered with a `retryAfterMs` (a rate limit, a
   * create still pending). The sample counts, but it neither extends nor
   * resets the transient streak: being told to wait is not an outage (§15).
   */
  async record(
    component: HealthComponent,
    startedAt: number,
    error?: ErrorCategory,
    waitStated = false,
  ): Promise<void> {
    const state = this.states[component];
    const now = this.deps.clock.now().getTime();
    state.checkedAt = new Date(now).toISOString();
    state.samples.push({
      at: now,
      duration: Math.max(0, now - startedAt),
      ...(error === undefined ? {} : { error }),
    });
    this.prune(state, now);
    if (error !== undefined) state.lastErrorCategory = error;
    if (state.breaker === 'closed' && !waitStated) {
      state.failures =
        error === 'transient'
          ? [...state.failures.filter((at) => now - at <= 60_000), now]
          : [];
      if (state.failures.length >= 5) this.change(component, 'open');
      else if (error === undefined && this.announced)
        this.publish(component, this.status(component));
    }
    await this.sync();
  }

  /**
   * Startup (FX5): probe every component once and publish its actual state.
   * Breaker transitions alone never publish a component that is healthy from
   * the start, which would leave the projection's `degraded` seed forever.
   * Idempotent across restarts: a state equal to the last persisted
   * `health.changed` is not republished (`checkedAt` then stays at that
   * event). A failed probe with a closed breaker publishes `degraded`; the
   * next successful call publishes `healthy`. Call after `restore()`.
   */
  async publishInitial(): Promise<void> {
    await this.refreshScm();
    for (const component of HEALTH_COMPONENTS) {
      let failed = false;
      try {
        await this.call(component, () => this.probe(component));
      } catch {
        failed = true;
      }
      this.publish(
        component,
        failed && this.states[component].breaker === 'closed'
          ? 'degraded'
          : this.status(component),
      );
    }
    this.announced = true;
    await this.sync();
  }

  /**
   * The runtime identity probe succeeded (FX5): fake mode once the fake
   * runtime is up; orca mode after CoordinatorIdentity `ensure()`. `verified`
   * is the runtime's own verdict (orca: version within the supported range,
   * §19). Before publishInitial it is only recorded (that event carries it);
   * afterwards a changed value republishes `runtime` with `runtimeVerified`.
   */
  async runtimeIdentityVerified(verified: boolean): Promise<void> {
    this.runtimeVerified = verified;
    if (!this.announced) return;
    this.publish(
      'runtime',
      this.publishedState().runtime?.status ?? this.status('runtime'),
    );
    await this.sync();
  }

  /** Route HEALTH_TIMER_PREFIX deliveries here from the composition root. */
  async onTimer(timer: ScheduledTimer): Promise<void> {
    if (timer.id === HEALTH_TIMER_PREFIX + 'clock')
      return this.clockTick(timer);
    if (timer.id === HEALTH_TIMER_PREFIX + 'login') return this.loginTick();
    if (timer.id === HEALTH_TIMER_PREFIX + 'scm-status')
      return this.refreshScm();
    if (timer.id === HEALTH_TIMER_PREFIX + 'scm-limit') {
      this.publishScm();
      return this.sync();
    }
    const component = HEALTH_COMPONENTS.find(
      (c) => timer.id === `${HEALTH_TIMER_PREFIX}${c}`,
    );
    if (component === undefined) return;
    const state = this.states[component];
    if (
      state.breaker !== 'open' ||
      state.probeAt === undefined ||
      this.deps.clock.now().getTime() < state.probeAt
    )
      return;
    this.change(component, 'half_open');
    await this.sync();
    let success = false;
    try {
      await this.call(component, () => this.probe(component));
      success = true;
    } catch {
      /* Category recorded above; no raw error enters health events. */
    }
    this.change(component, success ? 'closed' : 'open');
    await this.sync();
    if (success) {
      // Each waiter re-checks the breakers its own command kind needs.
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }
  }

  /** Structurally matches HealthView without importing the API boundary. */
  snapshot() {
    const now = this.deps.clock.now().getTime();
    const components = Object.fromEntries(
      HEALTH_COMPONENTS.map((component) => {
        const state = this.states[component];
        return [
          component,
          {
            status: this.status(component),
            breaker: state.breaker,
            ...(state.checkedAt === undefined
              ? {}
              : { checkedAt: state.checkedAt }),
            ...(component === 'usage' && state.breaker !== 'closed'
              ? {
                  detail:
                    'Usage unavailable; budgets use wall-clock timeouts and max rounds.',
                }
              : {}),
          },
        ];
      }),
    ) as Record<
      HealthComponent,
      {
        status: 'healthy' | 'degraded' | 'unhealthy';
        breaker: Breaker;
        checkedAt?: string;
        detail?: string;
      }
    >;
    const scmWarnings = this.scmWarnings();
    return {
      status: this.dispatchBlocked
        ? ('unhealthy' as const)
        : components.usage.status === 'degraded' ||
            components.scm.status === 'degraded'
          ? ('degraded' as const)
          : ('healthy' as const),
      runtime: {
        ...components.runtime,
        ...this.deps.runtime,
        ...(this.slept ? { warnings: ['host_slept'] } : {}),
      },
      scm: {
        ...components.scm,
        ...(this.scm.login === undefined ? {} : { login: this.scm.login }),
        ...(this.scm.tokenSource === undefined
          ? {}
          : { tokenSource: this.scm.tokenSource }),
        ...(scmWarnings.length === 0 ? {} : { warnings: scmWarnings }),
        ...(this.scm.rateLimit === undefined
          ? {}
          : {
              rateLimit: {
                limit: Math.max(
                  GITHUB_PRIMARY_LIMIT,
                  this.scm.rateLimit.remaining,
                ),
                ...this.scm.rateLimit,
              },
            }),
      },
      store: components.store,
      usage: { ...components.usage, sources: [] },
      adapters: HEALTH_COMPONENTS.map((adapter) => {
        const state = this.states[adapter];
        this.prune(state, now);
        const durations = state.samples
          .map((s) => s.duration)
          .sort((a, b) => a - b);
        const calls = durations.length;
        const failures = state.samples.filter(
          (s) => s.error !== undefined,
        ).length;
        const percentile = (p: number) =>
          durations[Math.ceil(calls * p) - 1] ?? 0;
        return {
          adapter,
          calls,
          failures,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          failureRate: calls === 0 ? 0 : failures / calls,
          ...(state.lastErrorCategory === undefined
            ? {}
            : { lastErrorCategory: state.lastErrorCategory }),
        };
      }),
    };
  }

  /**
   * Runs a component's probe, bounded so that a hung adapter (an `orca` or
   * `gh` that never answers) fails it as `transient` instead of blocking
   * startup, the half-open probe or the post-sleep recheck; the late result
   * is ignored.
   */
  private probe(component: HealthComponent): Promise<void> {
    return this.bounded(component, this.deps.probes[component]);
  }

  private bounded(
    component: HealthComponent,
    run: () => Promise<void>,
  ): Promise<void> {
    const ms = this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PortError(
              'transient',
              'probe_timeout',
              `${component} health probe timed out after ${ms} ms`,
            ),
          ),
        ms,
      );
    });
    return Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
  }

  private prune(state: ComponentState, now: number): void {
    state.samples = state.samples.filter((s) => now - s.at < 300_000);
  }

  private status(
    component: HealthComponent,
  ): 'healthy' | 'degraded' | 'unhealthy' {
    return this.states[component].breaker === 'closed'
      ? component === 'scm' &&
        (this.scmPace() === 'critical' ||
          this.scm.loginMismatch ||
          this.scm.pollFailure !== undefined)
        ? 'degraded'
        : 'healthy'
      : component === 'usage'
        ? 'degraded'
        : 'unhealthy';
  }

  private change(component: HealthComponent, breaker: Breaker): void {
    const state = this.states[component];
    state.breaker = breaker;
    state.failures = [];
    this.publish(component, this.status(component), true);
    if (breaker === 'open') {
      state.probeAt = this.deps.clock.now().getTime() + 10_000;
      this.deps.scheduler.schedule({
        id: `${HEALTH_TIMER_PREFIX}${component}`,
        workflowId: '__health__',
        fireAt: new Date(state.probeAt).toISOString(),
      });
    } else delete state.probeAt;
  }

  private publishedState(): Partial<Record<HealthComponent, Published>> {
    if (this.published) return this.published;
    const published: Partial<Record<HealthComponent, Published>> = {};
    let events;
    try {
      events = this.deps.store.read({ workflowId: null });
    } catch {
      // Store outage: compare against nothing (may republish); seed again later.
      return published;
    }
    for (const event of events) {
      if (event.type !== 'health.changed') continue;
      const p = event.payload;
      const verified = p.runtimeVerified ?? published[p.component]?.verified;
      published[p.component] = {
        status: p.status,
        ...(p.breaker === undefined ? {} : { breaker: p.breaker }),
        ...(verified === undefined ? {} : { verified }),
      };
    }
    return (this.published = published);
  }

  /** Queues `health.changed` unless the store already says exactly this
   * (`force`: breaker transitions always publish, as before FX5). */
  private publish(component: HealthComponent, status: Status, force = false) {
    const breaker = this.states[component].breaker;
    const verified = component === 'runtime' ? this.runtimeVerified : undefined;
    const published = this.publishedState();
    const last = published[component];
    if (
      !force &&
      last?.status === status &&
      last.breaker === breaker &&
      (verified === undefined || last.verified === verified)
    )
      return;
    published[component] = {
      status,
      breaker,
      ...(verified === undefined ? {} : { verified }),
    };
    const payload: EventPayload<'health.changed'> = {
      component,
      breaker,
      status,
      ...(verified === undefined ? {} : { runtimeVerified: verified }),
    };
    this.pending.push({
      type: 'health.changed',
      payload,
      workflowId: null,
      occurredAt: this.deps.clock.now().toISOString(),
      source: 'system',
      provenance: 'observed',
      schemaVersion: CURRENT_SCHEMA_VERSION['health.changed'],
    });
  }

  /** Store outages retain health events in memory until a later probe can flush.
   * The in-memory breaker blocks commands even when durable pause writes fail.
   * Only our three unhealthy reasons are resumed; human/budget pauses survive.
   */
  private sync(): Promise<void> {
    this.syncing = this.syncing.then(async () => {
      try {
        if (this.pending.length > 0) {
          this.deps.store.append([...this.pending]);
          this.pending.length = 0;
        }
        for (const runner of this.deps.workflows()) {
          if (runner.state.workflow?.status !== 'running') continue;
          const workflowId = runner.state.workflow.id;
          const meta = {
            occurredAt: this.deps.clock.now().toISOString(),
            source: 'system' as const,
          };
          const held = [...this.scmHolds.values()].includes(workflowId);
          for (const component of ['runtime', 'scm', 'store'] as const) {
            const reason = `${component}_unhealthy` as const;
            const paused = runner.state.workflow.pausedReasons.includes(reason);
            const blocked =
              this.states[component].breaker !== 'closed' ||
              (component === 'scm' && held);
            if (paused === blocked) continue;
            await runner.dispatch({
              type: blocked ? 'PauseWorkflow' : 'ResumeWorkflow',
              reason,
              ...(blocked && component === 'scm' && held
                ? { detail: 'rate_limited' }
                : {}),
              meta,
            });
          }
          // AP5: resume only `auth` pauses this monitor made; a 401 pause stays.
          const authPaused =
            runner.state.workflow?.pausedReasons.includes('auth') === true;
          if (this.scm.loginMismatch && !authPaused) {
            await runner.dispatch({
              type: 'PauseWorkflow',
              reason: 'auth',
              detail: 'active_account_mismatch',
              meta,
            });
            this.authPaused.add(workflowId);
          } else if (
            !this.scm.loginMismatch &&
            this.authPaused.delete(workflowId) &&
            authPaused
          )
            await runner.dispatch({
              type: 'ResumeWorkflow',
              reason: 'auth',
              meta,
            });
        }
      } catch {
        /* Retry publication and pause synchronization on the next observation/probe. */
      }
    });
    return this.syncing;
  }
}
