# ObservationLoop

Create after runner recovery/reconciliation. Supply `WorkflowRunners.all()` through
`workflows`, the event store, ports, clock, scheduler and `createRedactorFactory()`.
Call `start()`, and route timers with `OBSERVATION_TIMER_PREFIX` to `onTimer()`.
Call `stop()` then await `idle()` before closing the store. In-flight port reads
finish and commit; stop cancels future timers. Paused workflows remain observed.

The submission service can supply `usageIdentity(attempt)` with its recorded
`reportedSessionId`; dispatch ID and transcript-message hints are fallbacks.
A session's runtime poll is independent of usage and SCM polling. Calls for the
same source/scope serialize. Each batch derives against a private snapshot and
commits events, provider cursor and accounting/head baseline in one runner append.
No raw output is persisted. Assistant turns deduplicate by attempt/message ID.

SCM polls every 15 seconds, or 30 seconds with an open final-PR gate. Only the
actual SCM merge commit exempts a final merge from default-head movement. Worker
merges remain driven by backend command success; poll results only confirm them.
Conclusion Issue body hashes update open gates; label-only changes do not change
gate versions. Later edits emit drift.

Budget formulas support sums of token counters with optional nonnegative decimal
weights (`cacheRead * 0.1` or `cacheRead × 0.1`). Each sample's computed budget is
rounded up to the integer event contract. Unsupported syntax is rejected at
construction. A cumulative regression fails ingestion without advancing its cursor.

Runtime adapters own raw Orca escalation filtering, including `finished` and
`turn-start-unobserved`. Unexpected stops/exits emit `seat.exited{expected:false}`
and pause for anomaly handling. High policy hits emit `seat.policy_violation`
and `anomaly.detected` through the runner; T16's exception policy owns the stop
outbox effect (the base branch still has its policy stub). Tests exercise that
runner/executor path using an injected policy. T33 owns production wiring.
