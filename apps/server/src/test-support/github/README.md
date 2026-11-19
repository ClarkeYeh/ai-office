# GitHub test support (M3)

T0 provides collection gates and test routing only. T7 owns the injected-fetch
recorder/replayer, runtime safety checks, live lock, ledger, git pusher and janitor.
No live GitHub calls are implemented here by T0.

## Test routing

- Offline unit and replay tests use `*.test.ts` and run in `pnpm test` and coverage.
- Live tests use `*.github.test.ts`, collected only by `@ai-office/server-github`.
  Every live suite must use `realGithubSuite`; perform external work inside test
  hooks or test bodies, never at module scope or inside a suite declaration.
- `pnpm test:github` selects live contract tests outside `acceptance/github/`.
- `pnpm test:github:e2e` selects `apps/server/src/acceptance/github/` only (T15–T17).
- Both commands require `AIO_REAL_GITHUB=1` and CI to be unset, use at most two
  workers and serialize files. Missing opt-in or any defined CI value skips with a
  reason. The collection helper also uses `describe.skip` under those conditions.
- `pnpm github:record <scenario>` and `pnpm github:janitor --ledger <path> [--apply]`
  are nonzero stubs until M3-T7. T7 will also add janitor `--scan`.

## T7 runtime safety contract

Collection gating does not authorize live access. Before any live operation,
verify the exact repo and clone fetch/push origins are `ClarkeYeh/ai-office-spike`,
read the token using `gh auth token --user ClarkeYeh --hostname github.com`, verify
both token login and active account are ClarkeYeh, require remaining quota at least
1,500, and acquire the exclusive GitHub live lock. Never switch accounts. All live
suites run serially; Codex development workers use offline replay only.

Write ledger intent before creating each resource; use run IDs of 12 hex digits,
branches `ai-office/t<runId>…` and titles `[aio-test <runId>] …`. Close ledger PRs
before closing Issues and deleting permitted branches. Never merge into the default
branch, force push, delete Issues, change repository settings, or touch other runs.
Finish with zero leftovers and a zero namespace scan. The reusable `ai-office-test`
label marks closed test Issues; labels are not leftovers.

Only this test-support directory may import `node:child_process` for the GitHub
harness, and subprocesses are limited to git. Dependency rules enforce placement;
code review must verify the executable and arguments. Use fixed GitHub noreply
author/committer identity and deterministic dates for synthetic commits. The
production adapter uses injected fetch, never filesystem or subprocess access.
See `fixtures/github/README.md` for the fixture envelope and sanitization rules.

## T12 fake-mode SCM injection contract

Add optional programmatic `testOnly.scm: ScmPort` to server start options. Accept it
only with `--dev`; reject all `testOnly` options in production. Do not expose it as a
CLI flag or config key. In dev fake mode, use the supplied port instead of scm-fake
while preserving the fake runtime and its other test controls; without injection,
existing all-fake behavior is unchanged. `--dev --runtime orca` may also receive the
injected SCM. Main remains the sole composition point; no adapter imports another
adapter. T15 supplies a harness-approved real SCM for mixed E2E; ordinary CI supplies
fake/replay SCM. This injection does not bypass live gates or authorize GitHub access.
