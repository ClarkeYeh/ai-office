# Sleep and wake (M2-T15)

`withSleepWake(runtime, options)` adds the backend sleep lifecycle without
changing RuntimePort. T10 owns composition in `main.ts`:

1. Decorate `createOrcaRuntime(...)` with `withSleepWake`, supplying the same
   CLI, identity, ledger, version monitor and logger. Pass
   `settings.orca.preventSleep` (defaults to true).
2. Use the decorated runtime for all session and observation calls. Its
   observer replaces the base observer; do not run the base observer separately.
3. Pass `forceRecheck: () => runtime.forceRecheck()` to HealthMonitor. Its
   `aio-health:clock` timer uses the existing health timer routing. A monotonic
   clock can be injected with `monotonicNow` (defaults to `performance.now`).
4. Recover active sessions through the usual observation path. On shutdown,
   stop observation, call `health.close()`, then await `runtime.close()`.

The detector checks wall/monotonic divergence and scheduling lateness greater
than 30 seconds. It reports `host_slept` in `health.changed.detail` and runtime
warnings. Clock corrections or a long event-loop stall can also cause a safe
recheck. It does not infer worker death from a clock jump.

`forceRecheck` serializes behind observation, replaces volatile observer state,
and forces identity/ownership/version checks. The next normal `observe` does
full worker-list reconciliation and inbox backfill using the application's
committed cursor. Keeping ingestion in that path avoids dropping events when
an uncommitted batch is replayed. Worker exit becomes `agent.exited`; this
module never spawns or resends worker work. Rechecks and observation are
serialized to prevent an old long poll from overwriting a new observer.

On macOS, active sessions share one `/usr/bin/caffeinate -i -w <backend pid>`
child. Closing the last session or the backend releases it; `-w` also ends the
assertion if the backend exits unexpectedly. Other platforms and
`preventSleep = false` skip it. A launch failure is a warning, not a workflow
failure. **Closing the laptop lid can still put the machine to sleep.** Wake
reconciliation remains necessary even when sleep prevention is enabled.

No public contracts or registry names are added: `host_slept` already appears
in M2_PLAN §8.4. Production wiring is intentionally left to T10 under §9 file
ownership. Real-Orca verification belongs to the coordinator: CLI-only
`pnpm test:orca`; this task's tests use an injected CLI and process launcher.
