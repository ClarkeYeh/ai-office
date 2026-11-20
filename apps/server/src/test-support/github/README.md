# GitHub live harness

Only `ClarkeYeh/ai-office-spike` is permitted. `openHarness()` acquires the
machine-wide `~/.ai-office/test-state/github-live.lock`, checks both the selected
and active GitHub account, checks core quota (at least 1500), and resolves the
owner's noreply identity. It requires `AIO_REAL_GITHUB=1` with `CI` absent.
It never switches accounts. Credentials and raw errors are never persisted.

Build the server before using the scripts:

```sh
pnpm --filter @ai-office/server build
AIO_REAL_GITHUB=1 pnpm github:record smoke
AIO_REAL_GITHUB=1 pnpm github:janitor --ledger /absolute/private/ledger.json
AIO_REAL_GITHUB=1 pnpm github:janitor --ledger /absolute/private/ledger.json --apply --scan
```

`record smoke` is the initial fixed scenario registry entry; later contract and
acceptance work can add named scenarios. It creates one synthetic issue,
cleans it, requires zero ledger leftovers and zero independent scan results,
and writes a sanitized recording without overwriting an existing fixture.
`test:github` and `test:github:e2e` retain the dedicated serial Vitest project.
All live suites must use `withHarness` (automatic cleanup) or `openHarness`
with cleanup and close in nested `finally` blocks. The CLI skips in CI or
without opt-in, while the programmatic live gate fails closed.

Inject `harness.fetch` into the adapter's fetch option. The transport serializes
calls, guards ownership, writes intent before each create, and fills in returned
numbers. Use titles `[aio-test <runId>] …`, command IDs `t<runId>:<purpose>`, and
branches `ai-office/t<runId>-<purpose>` or `ai-office/t<runId>/<purpose>`.
Issue/comment/PR bodies must contain `<!-- ai-office:cmd=<commandId> -->`.
Objects that stand in for the owner's own (T15: an unmarked Issue, a
`/approve` comment) instead carry `<!-- aio-test:owner=<commandId> -->`: AI
Office sees them as unmarked, while the ledger, ownership checks, janitor and
scan treat both markers alike.
The low-level gate transport is private plumbing for authentication and janitor;
scenario code must use the guarded transport. Production T17 uses
`registerEvents(ledger, events, workflowId, shortId)` to import matched
`command.issued` / `command.succeeded` pairs from its event store. That explicitly
claims its production namespace and exact command markers, without copying text.

Ledger writes use a private temporary file, fsync, and atomic rename. Cleanup
recovers lost responses by exact marker, closes PRs before issues, and deletes
only ledger-owned unprotected branches. PR 3, main, and unrelated resources
are never touched. Issues are retained closed with `ai-office-test`; this label
identifies synthetic test history and is intentionally reusable. Commit statuses
and labels are not leftovers. Comments are deleted only with an exact marker
and owner match. A still-invisible create intent remains unresolved and causes
failure, so retry the janitor after visibility catches up. Do not manually erase
an unresolved intent to make the counter zero. Dry-run never mutates GitHub.
The independent scan reports all test namespaces but never adopts or deletes
another run's resources. Malformed locks require manual inspection; a live PID
is never stolen, and a confirmed dead PID can be reclaimed.

`RecordingFetch` stores an ordered request signature (method, template, exact
normalized path, sorted query, normalized body SHA-256), status, allowlisted
response headers, and sanitized response. No request headers or plaintext body
are recorded. Run IDs normalize to `000000000001` before sanitization. Pagination
links use relative API paths on disk and are restored on replay. Node IDs use
stable per-tape placeholders; response API URLs and avatars become valid URLs
under the permitted spike HTML root before generic redaction and the final leak
scan. Git commit `author`/`committer` signature emails (commit, branch, compare
and pull commit rows) become `<github-noreply>` before the leak scan; the adapter
never reads them. In commit messages, only the exact public service senders
`noreply@anthropic.com` and `noreply@github.com` (and the users.noreply form)
become placeholders; every other email still fails. The entropy rule skips a
recorded request `path` only when it is the exact concrete form of its
allowlisted `pathTemplate` (spike root, numeric ids, refs, SHAs); token-prefix
and email checks still run on it. A product branch `ai-office/<shortId>-<slug>`
is kept as an exact `ref` value. Both rules live in `ref-redaction.ts` and its
fixture-scan twin. A leak scan failure while
recording is a `TapeLeakError`: the adapter sees it as `github_unavailable`, so
the recorder keeps it and `assertNoLeak()`/`save()` raise it as a harness error.
Persistence errors are aggregated at suite end so later cases still run. `ReplayFetch`
has no network fallback; missing, extra, reordered, or different calls fail.
Always call `assertConsumed()`. Supply known synthetic `bodies` for SHA-256
rehydration (including markers); unknown summaries become deterministic strings.
T1's historical per-probe envelopes omit request hashes and are not silently
accepted as strict replay traces; bind them explicitly in contract scenarios.

`GitPusher.create(ledger, harness.gate, {sourcePath?})` creates an isolated clone.
`push({branch, base, itemKey?})` requires a full base SHA and this run's branch,
adds only a deterministic `aio-test/<runId>/<itemKey>-<n>.md`, pins both commit
identities and dates, checks the commit diff and both remote URLs, rechecks the
active account, and pushes one explicit refspec without force. It never checks
out local branches (detached HEAD), so no local branch cleanup is needed;
call `close()` to remove its temporary clone. The supplied `sourcePath`, if any,
is validated but never modified. `AIO_TEST_GIT_EMAIL`, when supplied, must equal
the authenticated owner's API-derived noreply identity. Child processes in
this harness execute only explicit `git` and `gh auth token` argument arrays;
git's credential helper uses the already-verified active GitHub account.

## Shared contract recording (T8)

After review, the integrator uses `AIO_REAL_GITHUB=1 pnpm test:github:record`.
This runs only the shared ScmPort live binding and its encoded-ref probe, serially.
See [the contract recording instructions](../../../../../../fixtures/github/2022-11-28/contracts/README.md)
for pending evidence, replay commands and deliberate live exclusions. Cleanup
hooks have explicit 300-second bounds in the shared suite (independent of project
defaults); live cases have a 360-second bound for pending-window tests.
Git pushes obtain the selected `--user ClarkeYeh` credential and pass it only in
process-local HTTP configuration, never via the active-account credential helper.
The independent scan includes exact imported production command IDs and claim
namespaces as well as all test namespaces; it still never mutates by prefix alone.

Public GitHub clone remotes, user API URLs and noreply author addresses use
stable fixture placeholders before scanning. Planted tokens, private emails
(including bodies), and home paths are rejected before generic redaction.
The recorder preserves only validated test namespace `ref` fields; each segment
is still checked. The offline fixture scanner applies the same narrow exception
only under the GitHub fixture tree, without changing production redaction.

## Production startup acceptance (T16) and T17 preparation

`production-smoke.ts` is an Orca runner scenario (`acceptance/github/production.github.test.ts`,
`pnpm test:github:e2e` after `pnpm -r build`, with the Orca variables as well).
It starts the built `ai-office start` without `--dev` in an isolated home under the
Orca harness's private dataDir, with `orca.homeDir` set to the owner-approved
`~/.ai-office/orca-home`. It runs the refusal matrix first (`--fake` without
`--dev`, an invalid `AI_OFFICE_GITHUB_TOKEN`, an expectedLogin that is not
logged in, and an active-account mismatch through an in-process injected
`readActiveGhLogin`), then a clean start, spike registration and one restart.
Production only reads GitHub: the T7 ledger stays empty, and the spike's open
objects and `ai-office/` branches must be identical before and after. Shims are
ledgered by marker scan because production has no `testOnly` seam. T17 helpers
(`smokeRequirement`, `smokeItems`, `driveSmokeToFinalGate`, `noreplyPlan`) only
prepare; nothing here sets the clone's git identity.

`external-merge.ts` replays the owner's hand-merge of spike PR #144 (GA level,
GET only): `getPR`, then a poll from a cursor that last saw the PR open reports
`pr.state` merged with `mergedBy`/`mergeCommitSha` and `main` moving. Collection
rows are scoped to PR #144 before the adapter sees them. The live test writes
`observations/external-merge-pr-144.json` only with `AIO_GITHUB_RECORD=1`.

## Real-agent smoke (T17)

`smoke-scenario.ts` (`acceptance/github/smoke.github.test.ts`, with `AIO_REAL_AGENTS=1`,
under `caffeinate -i`) starts the built `ai-office start` in production mode in the
same isolated home layout as T16, registers the spike, and runs the built-in
template with real Claude and Codex agents up to the final-PR gate. The scenario
never merges and never decides the final-PR gate: it writes the final PR URL to the
private `AIO_T17_STATUS` file, the owner merges by hand on GitHub, and the backend
observes it. Exception gates and escalated questions also wait for the owner
through `<AIO_T17_STATUS>.decision.json`. After the workflow completes, the scenario
performs the owner's "clean up" (`POST /api/v1/workflows/{id}/cleanup`) and waits for
those commands before it stops the backend. Production SCM objects are imported
into the T7 ledger from the workflow's own issued/succeeded events
(`registerEvents`); agent-pushed worker branches are covered by the shortId claim
and removed by the owner's cleanup or the Orca janitor. The report
(`AIO_T17_REPORT`) holds counts, kinds and booleans only; emails are compared and
never written. The repo-local noreply identity must already be set in the clone
(`noreplyApplied`); the scenario refuses to start otherwise.
