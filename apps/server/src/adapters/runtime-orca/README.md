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
T6 owns observation and cursor payload. No production RuntimePort is claimed by
this foundation. `orcaSubprocessPolicy` is exported for T10's composition-root
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
