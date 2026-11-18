# Real Orca harness

Only an integrator/coordinator runs live tests. CI and dev workers use replay.
The harness never restarts Orca, upgrades it, changes settings, or registers a repo.

## Offline API

- `RecordingExec` decorates the T3 `Exec` boundary (usable beneath both OrcaCli and
  GitCli). It holds raw responses only in memory and writes sanitized recordings
  with mode 0600 outside the working repository. `responseEncoding: "text"` is used
  for git output; JSON receipts retain the day-1 envelope and exit code.
- `ReplayExec({ default: recordings, stimulusName: recordings })` matches ordered
  argv, binds UUID placeholders, rehydrates summarized bodies, and refuses unused
  calls before `stimulus(name)`. T1 individual JSON envelopes can be loaded directly.
- `FixtureNormalizer` in redaction maps UUIDs consistently to valid UUIDs, including
  handles/pane keys/repo ids, and home paths to `<home>`. Short Orca ids remain intact.
  Input argv is removed and bodies become byte length plus SHA-256. Instantiate once
  for a whole recording session. The fixture sanitizer CLI uses the same class.

## CLI-only smoke (integrator)

Set `AIO_REAL_ORCA=1`, `AIO_TEST_REPO_PATH` to the spike clone,
`AIO_ORCA_BIN` to an absolute executable, and `AIO_TEST_BASE_SHA` to a fetched commit.
`AIO_TEST_REPO_URL` defaults to the dedicated spike URL. Both HTTPS and GitHub SSH
origins identify the same repository; lookalike hosts/repos are rejected.
The owner-approved `~/.ai-office/orca-home` folder must already be registered.

Run `pnpm test:orca --maxWorkers=2` or `pnpm orca:record smoke`. The lifecycle is
shim → run → pre-created local branch → worktree → cleanup. No agent is launched.
Each file/session has its own private temporary dataDir; set `AI_OFFICE_HOME` to
`harness.ledger.dataDir` when launching a test backend. Do not mutate global env
in concurrent test files. Runs remain in Orca because it has no delete-run API.

`pnpm orca:record custom --scenario /absolute/compiled-scenario.js` loads a trusted
module exporting `run(harness)`. Agent scenarios additionally need
`AIO_REAL_AGENTS=1`. Use `harness.command` (owned resources, strict flags), not raw
Orca execution. Register extra SCM branches in the private ledger before creating
those resources. `worker-start`/`send` receipts automatically add dispatches and tasks.
Use `installCleanup(afterAll)` in test suites, including assertion-failure cleanup.
`collectDispatchUsage` connects the T7 session-log adapter and deduplicates cumulative samples; `collectUsage(read)` takes a usage-sessionlog reader returning numeric provider
usage totals and persists calibration samples without imposing token limits.
`detectRateLimitPause` delegates recognition to the pure detector supplied by T6;
transcript tails are passed only in memory.

## Composed backend smoke (integrator)

`composed.orca.test.ts` runs `composed-live.ts`: start `--dev --runtime orca` in
process with `AI_OFFICE_HOME` under the private dataDir and the approved
`~/.ai-office/orca-home` folder, settle the startup shim, shut down, then clean
and assert ledger 0 and scan 0. `harness.composedBackend(dir)` journals a pending
intent and the backend's `aio-shim:<hash>` marker before startup; the backend's
reported shim handles and runs are persisted before use. The scoped scan matches
only markers in this ledger, never the owner's own AI Office shim.

The scenario depends on M2-T10's follow-up dev-only shim-folder option only through
`composed-shim-seam.ts` (`testOnly.orcaShim = { folder, onShimCreated,
onRunCreated }`, hooks awaited after each receipt). Align that file when T10
lands. Until then the backend ignores the key, reports no shim, and the scenario
fails closed with the intent pending; reconcile with the janitor scan.

## Cleanup and recovery

`pnpm orca:janitor --ledger /private/dataDir/resources.json` prints a residual count.
Add `--apply` to clean. The configured clone must match the ledger and its origin is
rechecked before every operation. Cleanup stops/releases only recorded dispatches,
removes marked test worktrees without implicit branch deletion, marks tasks failed while the shim is still available,
closes the shim, then deletes recorded remote and local test branches. Local
`aio-test-*` branches are also accepted for legacy cleanup. It never sweeps all
prefix-matching resources belonging to another concurrent harness.

Creation IDs are journaled before validating receipt metadata or success status. A known creation clears its pending intent, so a bad receipt still permits cleanup. Qualified `refs/heads/` branches are normalized before comparison. Successful steps are persisted atomically, so cleanup is resumable. An unresolved
create receipt remains a pending intent and blocks destructive cleanup: inspect the
private ledger, reconcile the receipt/resource, then resume. Never retry a timed-out
mutation under a new request ID. Malformed/suffixed worktree receipts fail closed.
The normal self-test must leave zero residual resources; pending intents count as
residuals. Raw terminal output, credentials and transcripts are never journaled.

## Restart verification (T16 scenario extension)

`pnpm orca:p2 prepare --scenario /absolute/p2-scenario.js` requires a live input and
output TTY and exact typed confirmation that the coordinator found no other workers
and the owner checked for pending updates in Orca's UI. `status.remoteUpdateSupport`
only reports capability, so it cannot replace that check. An environment variable
alone cannot authorize this step. `test:orca:disruptive` routes to the same entry.

The T16 module exports `prepare(harness, confirmation)` and uses `prepareP2` to
write its observed version, run, shim, generation, cursor, lastSeq, recent request
IDs, dispatch states, backend pid/dataDir and ledger to a new 0600 state file inside
its private dataDir. It must complete observations and return the state file path. The command
then exits; restart is performed separately by the owner or authorized coordinator.

After coordinator recovery, run `pnpm orca:p2 verify --resume /private/p2.json
--scenario /absolute/p2-scenario.js`. The module's `verify(harness, state)` supplies
T16 assertions for identity recovery, receipts, mailbox dedupe, worker survival and
backend resume; the runner cleans in `finally`. No generic “restart passed” assertion
is substituted for these scenario-specific checks.

## Recheck after a natural upgrade

Record the same scenario with the new version, then run `pnpm orca:recheck
--previous /old/recordings --current /new/recordings` to compare response structure.
Re-run contract replay and CLI-only smoke before proposing a supportedRange change.
The harness never changes supportedRange automatically. Review sanitized fixtures
before copying them into `fixtures/orca/<version>`; run `pnpm fixtures:scan`.

## Dependency placement

Only this test-support subtree gains permission to import `node:child_process`;
use `spawn` without adding execa. Acceptance tests in `acceptance/orca/` call these
helpers instead of importing process APIs. Production cannot import test-support.
The git-only SCM substitute must implement ports directly and must not import any
adapter (including scm-fake); its in-memory model is independently implemented.

## Test-only SCM injection contract (implementation: M2-T10)

Add the following programmatic option to `startServer`:

```ts
testOnly?: { scm?: ScmPort };
```

Accept the option only when both `--dev` and `--runtime orca` are selected.
Providing `testOnly` in any other mode (including an empty object, fake runtime,
or non-dev Orca runtime) must throw `StartupError` before startup side effects.
In the allowed mode, `testOnly.scm` replaces the normally composed scm-fake;
omitting `scm` retains normal composition. The injected instance must serve all
SCM consumers, including observations and merge processing.

CLI arguments, `parseArgs`, config files and environment variables must not expose
this option. Production must never import or construct `scm-gitremote`; tests
construct it and pass it through the `ScmPort` interface. This adds no public
contracts schema or §8.4 registry name. T0 does not implement the injection.

T10 tests must reject fake/non-dev injection, prove the supplied instance is used
in dev/Orca mode, and verify unchanged composition when the option is absent.
T17a implements the git-only substitute here; T17 uses it for engine-driven E2E.

## Independent scan and CLI compatibility

`pnpm orca:janitor --scan` (or `janitor scan`) checks the configured spike origin
and cwd safety gate, then inventories test worktrees, `aio-test-shim` terminals
in the approved orca-home folder, and local/remote branches with either test prefix.
It works without a resource ledger and reports resources missing from a ledger.
Scan is read-only; `--scan --apply` is refused because a naming prefix does not
prove ownership. Use `--ledger ... --apply` for owned-resource cleanup.
The smoke now asserts both ledger leftovers and scan leftovers are zero after cleanup;
other concurrent test resources therefore also make that acceptance check fail.

Flags were checked against read-only Orca CLI help: run-use/run-show use `--id`,
consuming check uses `--terminal <shim> --run` (`--wait` is a switch), and
request-show uses `--request`. Worker stop/release take no `--from`; task-update
uses `--id --status` with the owned `--run --from`. Native terminal/worktree
commands never receive `--full`.

Repo-list recordings keep only rows whose exact path matches AIO_TEST_REPO_PATH
or HOME/.ai-office/orca-home; unrelated rows and inventory metadata are discarded
before normalization or persistence. `gitUsername` is redacted. Fixture scanning
rejects absolute home paths, including already-redacted and JSON-escaped paths.

Closed terminal rows (`exitCause` non-null or `connected: false`) are not live
leftovers, even while Orca still lists them. After cleanup, live shim-only
leftovers are rescanned for up to three seconds (at most 12 retries); persistent
shims still fail. Other resource leaks fail immediately. We retain pane-only
close: although `--tab` waits for durable persistence, it can also close other
panes in that tab, beyond the ledger-owned shim.
