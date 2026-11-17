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
Successful ordinary calls already in flight do not close an open breaker.

Runtime, SCM, and store outages block all new executor attempts and add their
own workflow pause reasons. In-flight calls can settle. A transient failure that
opens the breaker keeps its command issued, without a failure event or gate.
Recovery retries the same recorded arguments and command ID with a fresh retry
budget; the outcome's attempt count includes every actual call. Unrelated pause
reasons are preserved. Usage outages show degraded health and a budget fallback
message without blocking dispatch, per the coordinator's §10 decision.

Health events that cannot be persisted during a store outage remain in memory
and are retried on observations/probes. The in-memory breaker still blocks work.
Circuit state and statistics are process-local; `restore()` reopens breakers for
persisted unhealthy pause reasons and schedules recovery probes.

`snapshot()` matches `HealthView` and returns five-minute call/failure counts,
nearest-rank p50/p95 latency in milliseconds, and failure ratio in [0, 1]. Empty
windows return zeros. Last error categories are retained separately; raw adapter
error messages never enter health events or snapshots. Runtime-specific optional
metadata and usage-source inventory remain the real adapters' responsibility.
