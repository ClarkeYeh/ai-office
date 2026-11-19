# Startup recovery

The composition root first calls `WorkflowRunners.recover()`, then awaits
`Reconciler.reconcile(runners)` before admitting requests. A nonzero `pending`
count means runtime receipts or connectivity are unresolved: retry reconciliation
later, without accepting workflow writes. Pending requests are never redone.
Concurrent calls on the same reconciler share one pass.

The runner persists `runner.last-reacted` in EventStore ingest cursors after the
synchronous queue drains. It replays later events with their historical
**pre-event** state. Each derived effect has a receipt keyed by workflow, event
ID and effect index. The receipt is committed with the derived event(s), so an
interruption during a multi-effect reaction cannot duplicate internal commands
or timer events. External command IDs additionally deduplicate issuance. The
existing `redo` hook executes only persisted command arguments and recovers the
original envelope scope (including the implement stage for merge-queue work).
Effect receipts are retained; compaction is not implemented in M1.

Reconciliation checks runtime request receipts first. `absent` searches durable
`aio:` markers before redo; `pending` waits for another pass. Workspace lookup
uses the recorded deterministic name and `aio:<commandId>` comment; mismatches
are guards. Pinned workspaces recover their original `baseSha` and never refetch
onto a newer commit. SCM creation searches its command marker with `findByMarker(repo, id,
{since: issuedAt, kind})` and records the returned real `url`; nothing found
inside `CREATE_PENDING_WINDOW_MS` of the issue time is `pending` (the list can
lag), only later `redone`. A PR already merged must match the recorded
`expectedHeadSha` and the integration branch as base, or recovery gives up. Merges read PR
state first and backfill the recorded merge SHA when already merged. Remaining
idempotent operations redo their original arguments. A found result and its
reconciled event commit atomically. An unrecoverable result commits failure,
anomaly gate and pause together. Failed redos are also revisited after restart
in case a crash interrupted gate creation.

## Coordinator ruling for the token window

Approved in the T24 dispatch on 2026-11-17 (supersedes the older blanket rule
against issuing a second token): if no spawn `command.issued` exists yet, no
agent can have received the token. During restore only, an interrupted
materialization may rotate that attempt's token hash and rewrite the unissued
spec before its first issuance. SQLite checks the event ledger inside the same
transaction as rotation; only hashes persist in the database. Normal duplicate
issuance and rotation after issuance still fail.

Once issued, the spec's recorded path and SHA are immutable: recovery reads and
verifies those bytes, never regenerates the spec or token. Missing/changed specs
require intervention. `workflow.started.shortId` is always replayed unchanged.

T24 therefore also changes runner/commands, storage and runtime/SCM ports,
SQLite/system adapters, fake adapters, and test support. These are the minimum
recovery seams beyond the original reconciler-only scope. Fake runtime separates
request receipts from durable marker lookup and supports receipt pruning;
fake SCM exposes PR state and response-loss injection. Tests close/reopen a real
SQLite file and use fresh runners against the surviving simulated external world.
The application process crash is modeled by blocking further writes and discarding
its runner; the external world intentionally survives.
