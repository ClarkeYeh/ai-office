# Health monitor wiring

Construct `HealthMonitor` with the clock, scheduler, uninstrumented event store,
a lazy `workflows: () => runners.all()` callback, runtime mode/verification, and
one read-only probe per component. Pass the same instance as the optional
`health` dependency of `CommandExecutor`. Route scheduler deliveries whose IDs
start with `HEALTH_TIMER_PREFIX` to `await health.onTimer(timer)`; route other
IDs to `runners.onTimer(timer)`. After `runners.recover()`, call
`await health.restore()` before accepting dispatch so persisted unhealthy pauses
require a fresh successful probe. Composition belongs to M1-T33.

The executor records each real handler attempt, including retries. Other adapter
callers can use `health.call(component, operation)` or call `record` with the
start timestamp and classified error after an operation. Do not instrument the
monitor's own event publication or double-count executor calls. `call` observes
calls without blocking them, so observations and read-only probes remain possible
while dispatch is paused. A synchronous store keeps its synchronous interface;
its caller reports outcomes through `record` rather than substituting `call` for
a synchronous port method.

Five consecutive transient failures completed within 60 seconds open a component's
breaker. A success or a non-transient error resets that streak. Probes run ten
seconds after opening or a failed probe; only one probe per component can run.
Every probe (startup's `publishInitial` included) is bounded by `probeTimeoutMs`
(default 5 s): a hung adapter counts as a transient failure, so startup still
serves and reports that component `degraded`.
Successful ordinary calls already in flight do not close an open breaker.

Runtime, SCM, and store outages add their own workflow pause reasons and block
the executor attempts that depend on them (`dispatchBlockedFor(kind)`, SPEC §15
S21): `scm.*` waits for the scm and store breakers, other `runtime.*` for the
runtime and store breakers, and `runtime.stop`/`runtime.release` only for the
runtime breaker, so a GitHub outage never holds a cancel, a hard budget stop or
a release. `dispatchBlocked` (any of the three) remains the overall status.
A failure carrying `retryAfterMs` is sampled but neither extends nor resets the
transient streak, so rate limits and pending creates never open a breaker. In-flight calls can settle. A transient failure that
opens the breaker keeps its command issued, without a failure event or gate.
Recovery retries the same recorded arguments and command ID with a fresh retry
budget; the outcome's attempt count includes every actual call. Unrelated pause
reasons are preserved. Usage outages show degraded health and a budget fallback
message without blocking dispatch, per the coordinator's §10 decision.

SCM detail (M3-T9): with `scmStatus` the monitor reads the adapter's report every
60 s (login, `tokenSource`, warnings, rate limit) into `HealthView.scm`, and
derives `scmPace()` for the ObservationLoop: `slow` below 1,000 remaining,
`critical` below 200, each left only 100 above its threshold (hysteresis), and
`critical` while a reported rate limit lasts. `critical` shows scm `degraded`
with breaker closed. The executor reports `rate_limited` waits
(`noteRateLimit` → `rate_limited`/`secondary_rate_limited` warnings) and a
command rate limited for over five minutes holds its workflow in
`paused{scm_unhealthy, detail: rate_limited}` until it settles. With
`activeLoginProbe` (T12) the active gh login is checked every five minutes; a
mismatch adds `active_account_mismatch`, shows scm `degraded` and pauses running
workflows with `auth`; a match resumes only the `auth` pauses the monitor made.

Health events that cannot be persisted during a store outage remain in memory
and are retried on observations/probes. The in-memory breaker still blocks work.
Circuit state and statistics are process-local; `restore()` reopens breakers for
persisted unhealthy pause reasons and schedules recovery probes.

`snapshot()` matches `HealthView` and returns five-minute call/failure counts,
nearest-rank p50/p95 latency in milliseconds, and failure ratio in [0, 1]. Empty
windows return zeros. Last error categories are retained separately; raw adapter
error messages never enter health events or snapshots. Runtime-specific optional
metadata and usage-source inventory remain the real adapters' responsibility.
