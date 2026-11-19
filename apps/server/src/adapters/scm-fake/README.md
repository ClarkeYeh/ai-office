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
- `loseNextResponse('createIssue' | 'comment')` makes the next create succeed but
  answer `transient create_outcome_unknown` with `retryAfterMs`
  (`CREATE_RETRY_AFTER_MS`), as scm-github does. A retry with the same command
  scans markers since the lost send: found → that object; not found within
  `CREATE_PENDING_WINDOW_MS` → `create_outcome_unknown` again; later → creates
  again, and the duplicate is reported as `object.duplicate`.
  `setListLag(ms)` hides new Issues and comments from marker scans for `ms`.
  (`injectResponseLost` keeps its M1 meaning: a plain `response_lost`.)
- `retargetExternally(pr, base, 'now' | 'during-next-merge')` moves a PR's base;
  during a merge the fake merges into the new base and answers
  `guard merge_base_changed`, as the read-back in scm-github does.

`poll` returns changes since an opaque, repository-scoped cursor. Repeating a
cursor replays the batch, enabling atomic ingest/retry tests; polling the returned
cursor without another mutation returns no events. This simulates ETag behavior
at the port boundary, without HTTP. State and returned objects are isolated.

Branch creation, pushes and merges of the default and `ai-office/` branches
emit `branch.head_changed` (PP3). Branches are created only under `ai-office/`;
merges are judged by the PR's actual base (must be `ai-office/`, never the
default branch) and honour `expectedBaseSha` (`conflict base_moved`) and
`expectedBase` (`conflict base_mismatch`, never merged); like scm-github's
`POST /merges`, a merge goes into the checked base. Deleting a
PR's head branch closes the PR, as on GitHub. `findByMarker` takes the `since`
and `kind` hint, returns the real-shaped URL (and `commentId` for comments) and
keeps the lowest match when duplicated. `deleteComment` removes only the
viewer's marked comments. The shared suite in `test-support/scm-port-contract.ts`
accepts a port and external edit/push controls so M3 can reuse it with HTTP fixtures.
