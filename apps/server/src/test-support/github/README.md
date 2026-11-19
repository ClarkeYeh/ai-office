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
scan. Persistence errors are aggregated at suite end so later cases still run. `ReplayFetch`
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
