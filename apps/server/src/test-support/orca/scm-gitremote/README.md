# Git-only SCM test double

`GitRemoteScm.create({ remote })` accepts an absolute local **bare** repository.
All writes require `ai-office-test/*`; `main` (or `defaultBranch`) is protected.
The instance owns a temporary clone; call `dispose()` to remove it. Local fixture
owners remove their bare repository separately. No production code imports this
module and it imports no adapter.

For T17, construct with `{ remote: harness.ledger.repoPath, harness }` and inject
through T10's `startServer({ testOnly: { scm } })` in dev/Orca mode. Live access
requires `AIO_REAL_ORCA=1`, no CI, the dedicated spike origin and push URL, and a
harness ledger. Branch creation is journaled before pushing; an existing remote
branch must already belong to that ledger. Worker branches created outside this
SCM must be registered by their creating harness before mutation. Call
`harness.installCleanup(afterAll)` or use the runner, whose janitor deletes owned
remote branches. `dispose()` only removes this instance's temporary clone.

`compareBranch` reads `ls-remote`, fetches history and counts `base..head`; base
may also be a full commit SHA (CP4). Missing refs return null. Merge checks the
expected remote head, uses detached `merge --no-ff`, then pushes with an exact
base lease so a concurrently moved base is never overwritten. A conflict resets
the temporary checkout. A successful retry returns the same merge SHA. There
is no atomic GitHub head-lock API: a worker must stop pushing while its merge
request is processed (the head is rechecked immediately before the push).

Issues, PRs, labels, comments and review comments are in memory, including command
markers, body-only hashes and replayable poll cursors. `poll` also observes remote
PR head changes. PR numbers and URLs are synthetic; no GitHub Issue or PR is
created. Checks report `none`, mergeability is `null`, and actual merge conflicts
are detected by git. `openPR` returns number, URL, head and base for artifact use.
State is not durable across restarting this double; no final PR auto-merge occurs.

M3-T2: `poll` also reports `branch.head_changed` for the default and test
branches it sees move. The M3 ScmPort semantics match scm-fake: `findByMarker`
hints, real-shaped URLs and comment IDs, `deleteComment`, `getPR` head/base/
mergedBy, `expectedBaseSha`, read-back `merge_base_changed`, PRs closed when
their head branch is deleted. Test controls: an injectable `clock`,
`loseNextResponse`, `setListLag`, `retargetExternally`, `createExternalIssue` and
`addExternalComment`.

## Verification

Offline tests: `pnpm exec vitest run apps/server/src/test-support/orca/scm-gitremote/index.test.ts`.
They bind the shared ScmPort suite with its optional `branchPrefix` fixture field
(default stays `ai-office/`) and use only disposable local bare repositories.

Integrator only: configure the parent harness README's environment and run
`pnpm test:orca apps/server/src/test-support/orca/scm-gitremote/live.orca.test.ts --maxWorkers=1`.
This launches no agents and never pushes `main`. It checks the two-parent merge
and worker ancestry; the runner cleans branches on success or assertion failure.
After a server build, the same scenario can be run using the harness runner with
`--scenario <absolute path to dist/test-support/orca/scm-gitremote/live-scenario.js>`.
