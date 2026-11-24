# Orca adapter foundation (M2-T3)

`DefaultOrcaCli` implements `OrcaCli`; recording/replay can replace that interface,
or replace its lower `Exec` boundary. `SpawnExec` always uses detached process
groups, no shell, bounded stdout and drained/discarded stderr. Errors contain no
response text. Callers retain request IDs across recovery; this layer never retries.

The composition root supplies one `CliScheduler` for all Orca calls, one
`CwdGuard` and a `CoordinatorIdentity.argsFor` implementation. The guard's
`listPaths` discovery callback must return the complete `worktree list --json`
inventory (including folder workspaces), use that same budget, and execute from
a previously verified safe location. Initialize the guard at startup. Discovery
must not call back through the same guard. Never substitute a repository-only
inventory: registered folder workspaces also infer caller identity.

The root should call `VersionMonitor.check()` on its periodic tick and
`check(true)` on every health probe. `ProcessGroups.cleanup()` takes a process
inspector returning `ps -o pid=,command= -g <pgid>` and a group terminator;
only an exact leader command digest match authorizes termination. A failed or
unmatched inspection does not authorize killing another process. Process records
are housekeeping, never a receipt or message delivery guarantee.

`AdapterState` is the structural PP2 seam (`read(scope)` / `write(scope, value)`),
compatible with T2's forthcoming `AdapterStateStore`. Ledger and process-group
state have separate `orca:*` keys. The ledger is a rebuildable cache, not an
application event transaction. Feed complete worker-list and task-list arrays
into `rebuild`; task titles supply `aio:<commandId>`. Follow-up dispatches resolve
to the original pure dispatch AgentRef through `followUpOf` or
`resource.originDispatchId`. Application command history remains authoritative
for backend-initiated stops after cache loss.

Opaque refs: session = run id; agent = dispatch id; workspace = full Orca worktree
id; question = message id. Cursor encoding is base64url UTF-8 JSON
`{"v":1,"data":<T6 payload>}`; decoding requires T6's payload schema.

T4 owns identity implementation; T5 owns methods and RuntimePort composition;
T6 owns observation and cursor payload. T5 now exports the RuntimePort factory
with observation explicitly injected. `orcaSubprocessPolicy` is exported for T10's composition-root
migration; main.ts is outside T3's file ownership. No contracts registry additions.

Real CLI-only validation must be run by the coordinator under M2 §1.4. Workers
run injected subprocess tests only. `GitCli.createBranch` is the additive local
branch operation required by day-1 P8's pre-create-at-SHA primary path.

`argsFor` has an additive optional context argument carrying command words and
an optional mailbox target. T4 uses it to generate `inbox --terminal run:<id>`
(or diagnostic dispatch targets) without permitting caller-supplied identity
flags. Unscoped inbox calls are rejected. Native commands such as `worktree
create` and initial `terminal create` do not support orchestration request
receipts: only orchestration mutate/consume commands receive `--full` and
`--retry-request`, and require a shim identity. This resolves the general T3
wording against SPEC §6.5's explicit native-command exception; T4 remains
responsible for bootstrap/reclaim identity policy.

## CoordinatorIdentity (M2-T4)

`ShimCoordinatorIdentity` implements SPEC §6.2 F2. Shim title
`AI Office · 請勿關閉 aio-shim:<sha256(dataDir)[0:12]>`; state lives under
`orca:shim` (handle, incarnation, location, handle history, per-run
`coordinator_handle`/`consumer_generation`/hijacked flag).

- Location: `folder-workspace` = `<dataDir>/orca-home`, detected via `repo list`;
  never registered here. Unregistered → `guard{shim_folder_workspace_unregistered}`,
  or the configured `repoMainWorktree` with the `shim_folder_fallback` warning.
- `ensure({force})`: 30 s throttle unless forced (startup, identity errors).
  `terminal list --worktree path:<location>`: the stored handle with an unchanged
  incarnation is reused (P2a: titles may be null after an app restart). Otherwise
  the newest title-matching shim is adopted or a new one created; other
  title-matching shims are closed. Runs bound to a previous shim of ours (and not
  hijacked) get one `run-use` each and their new generation is recorded at once;
  then `runtime.identity_restored` is queued.
- `checkOwnership(run, {force})`: per-run 30 s throttle; `run-show --full`; a
  different handle queues `runtime.identity_hijacked` once per generation; our
  own handle is owned at any generation, which is then recorded (a crash between
  `run-use` and the record must not look like a hijack). Never takes the run back.
- `withIdentity(run, op)`: `identity` → `ensure({force})` + one retry of `op`
  (which keeps its request id); `hijacked` (`consumer_fenced`) → immediate
  ownership check, then rethrow.
- `reclaimSession(run)` is idempotent; `track`/`untrack` register runs (T5 on
  run-create); `drainEvents()` hands identity events to T6, whose backfill and
  check re-issue follow `identity_restored`; `health()` feeds T10; `close()`
  honours `orca.shim.closeOnExit`.
- `RunOptions.terminal` (additive) carries the native `terminal show|read|close`
  target; `argsFor` only permits closing shims this class matched by title.

## Runtime methods (M2-T5)

`createOrcaRuntime` composes the methods with an injected T6 observer, sharing
`DispatchLedger`, `ShimCoordinatorIdentity`, `OrcaCli`, `GitCli`, and adapter
state. T10 supplies the system `IdGen.orcaRequestId` (UUIDv5 of the original
command ID), logger, data directory, version monitor, and optional CLI metrics.
All identity recovery runs through `withIdentity`; the one identity retry keeps
the exact request ID. Native workspace creation is recovered by its name and
`aio:` comment because Orca has no request receipts for it.

Workspace preparation fetches before resolving a base SHA. Explicit SHAs require
a fetch branch; `origin/<branch>` resolves after fetch; unfetched local branches
are rejected. Legacy `spawnAgent(new-worktree)` branch names are normalized to
fetch plus `origin/<name>` (the engine's planning caller still needs that update).
Checkout-existing pre-creates local W with `--no-track`, or uses guarded `branch
-f` for an unoccupied branch with no unpushed commits. Receipt branch names are
normalized from `refs/heads/`; paths always come from the receipt. A suffix is
removed before the temporary-branch / `checkout -B` fallback. Cleanup explicitly
removes only unchanged adapter-created branches, including branches Orca kept.

Before `worker-start`, the pending ledger and workspace association are durable.
Unknown outcomes query the same request ID, then rebuild from task markers;
failed starts recover their marked dispatch and release residual terminals.
Cleanup failures remain retryable, and never launch a replacement worker.
The private `orca-specs` files contain only the supplied launch prompt, not a
transcript; command fingerprints, markers and results contain no prompt text.
Non-terminal receipt modes add `chat_worker_identity_degraded` to health without
changing Orca settings. Follow-up sends put `aio:` in the subject and keep the original AgentRef while
targeting the latest resource owner. Worker lists are paginated. Reply-marker
recovery also checks scoped dispatch inboxes: the day-1 fixtures show that
replies are delivered there, rather than to the run inbox.

`release(removeWorkspace:false)` always preserves the workspace. With `true`,
both new-worktree and existing-worktree launches may remove a workspace, but
only when adapter state plus its exact `aio:` marker prove this backend prepared
it, no other unreleased ledger agent references it, and the dirty/unpushed guards
pass. Shared or externally supplied workspaces are preserved. A release can
succeed while cleanup returns `guard{workspace_in_use}` or `unpushed_commits`;
retrying cleanup is safe and never discards local commits. This ownership rule
was confirmed by the coordinator for prepared implement/on-call/wrap-up worktrees.

No public contracts or §8.4 registry names are added. Coordinator-approved scope
extensions are the additive Git helpers and read-only `orchestration run-list`
allowlist entry. The integrator must run CLI-only real-Orca workspace tests on
the approved test repository; this worker uses replay Exec tests only.

## Orca 1.4.272 observation notes (M5-FX-ORCA-OBS)

- **Question notices:** when a worker asks while the run's coordinator terminal
  has no running agent (always true for the shim), Orca 1.4.272 posts its own
  "decide it yourself" `status` message into the question's thread from
  `run:<id>`, in the same second.
  - `refreshAnswers` now counts a thread message as an answer only when it is
    our reply (`aio:<tag>` first line from `runtime.answer`) or comes from a
    handle other than the run. The question keeps the agent in `waiting_input`
    until AI Office answers.
  - Recorded shape: `fixtures/orca/1.4.272/inbox.dispatch.question-notice.ok.json`.
- **Transcript cadence:** 1.4.272 leaves `projection.evidence.lastObservedAt`
  empty, so a long turn never changes the worker-list signature. A live agent
  (`starting`, `working`, `waiting_input`) is now re-read every 15 s when its
  signature is unchanged; other agents every 30 s. Under limiter pressure these
  stretch to 30 s and 120 s. Ten such workers stay under 120 CLI calls per
  minute (unit-tested).
