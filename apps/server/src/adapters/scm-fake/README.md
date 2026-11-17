# Fake SCM

`createFakeScm({ clock?, mergeDelayMs?, delay? })` returns a `FakeScm` implementing
`ScmPort`. Register each repository with `addRepo(ref, metadata?)`; defaults are
`main`, public visibility, protected default branch, and the repository owner as
viewer. IDs and the default clock are deterministic. Inject `Clock` to advance
`updatedAt`; body hashes are real SHA-256 through Web Crypto.

Scenario controls:

- `pushBranch(repo, branch)` adds a commit and returns its SHA; this also permits
  external default-branch pushes. `compareBranch` counts commits reachable from
  head but not base, including merge ancestry.
- `editIssueBody`, `setLabels`, `addExternalComment`, `createExternalIssue`, and
  `mergeExternally` model changes outside AI Office. External merges intentionally
  bypass the backend default-branch guard.
- `setChecks`, `setMergeable`, and `addReviewComment` control PR observations.
- `setMergeDelay(ms)` delays backend merges. Inject `delay(ms)` for a manually
  controlled promise, or use fake timers with the default delay. Head SHA and
  merge eligibility are checked again after the delay.
- `inspectObject` returns a detached snapshot for assertions.

`poll` returns changes since an opaque, repository-scoped cursor. Repeating a
cursor replays the batch, enabling atomic ingest/retry tests; polling the returned
cursor without another mutation returns no events. This simulates ETag behavior
at the port boundary, without HTTP. State and returned objects are isolated.

`ScmEvent` has no default-branch-head event. External default-branch advancement
is observable through `compareBranch`; adding such an event is a separate ports
and contracts change. The shared suite in `test-support/scm-port-contract.ts`
accepts a port and external edit/push controls so M3 can reuse it with HTTP fixtures.
