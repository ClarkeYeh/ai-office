# Sleep and wake (M2-T15)

`withSleepWake(runtime, options)` adds the backend sleep lifecycle without
changing RuntimePort. T10 owns composition in `main.ts`:

1. Decorate `createOrcaRuntime(...)` with `withSleepWake`, supplying the same
   CLI, identity, ledger, version monitor and logger. Pass
   `settings.orca.preventSleep` (defaults to true).
2. Use the decorated runtime for all session, observation and answer calls. The
   decorator owns the only observer, including its replacement after a wake.
   Pass a forwarding observe facade to createOrcaRuntime; do not construct a
   second observer. Successful replies mark the current observer answered.
3. Pass `forceRecheck: () => runtime.forceRecheck()` to HealthMonitor. Its
   `aio-health:clock` timer uses the existing health timer routing. A monotonic
   clock can be injected with `monotonicNow` (defaults to `performance.now`).
4. Recover active sessions through the usual observation path. On shutdown,
   stop observation, call `health.close()` and `runtime.stopObservation()`
   immediately, then await `runtime.close()`. The immediate hook aborts polling
   and releases caffeinate before waiting for in-flight work to drain.

The detector checks wall/monotonic divergence and scheduling lateness greater
than 30 seconds. It reports `host_slept` in `health.changed.detail` and runtime
warnings. Clock corrections or a long event-loop stall can also cause a safe
recheck. It does not infer worker death from a clock jump.

`forceRecheck` serializes behind observation, waits for cancelled long-polls
to terminate, replaces volatile observer state, and forces identity/ownership/version checks. The next normal `observe` does
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

## Isolated composed dev smoke

Only explicit `--dev --fake <scenario>` or `--dev --runtime orca` startup is
accepted. Production and bare `--dev` fail before filesystem/config/runtime
side effects.

The hybrid accepts `--orca-home <absolute-path>` (programmatic
`StartOptions.orcaHome`) to select an already registered, owner-approved Orca
folder while `AI_OFFICE_HOME` remains an isolated test data directory. The
folder is verified using `repo list`; an unregistered folder fails and is
never registered automatically. Backend state, the shim ownership marker and
CLI cwd still belong to the isolated data directory.

A composed test can pass
`startServer({ dev: true, runtime: 'orca', orcaHome, testOnly: { scm, onShimCreated } })`.
Both `scm` and `onShimCreated` are optional. The callback receives each newly
created shim handle and may return a promise: it is awaited immediately after
the creation receipt so the harness can record the resource before subsequent
startup work. Reused handles do not trigger it. These hooks are not CLI or
config options and are refused outside explicit hybrid mode. The harness owns
its ledger and cleanup; composition never registers a folder or starts workers
just to probe startup.
