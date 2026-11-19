# scm-github poll (M3-T6)

`createPoller(deps)` returns `{ poll(repo, cursor) }` for T4 to compose into the
ScmPort. It needs `http`, `clock`, `viewerLogin` and `defaultBranch` from
`ScmGithubDeps` in `../methods/deps.ts`. The poll is read-only.

Events are the diff between the cursor's state and GitHub's current state, so a
replayed uncommitted cursor yields the same events. Each read sends the cursor's
ETag (or the HTTP cache's when the cursor has none); the HTTP layer sends a pinned
ETag only while it caches that representation, so after a restart reads are
unconditional and still diff correctly. Steady idle polls are all 304.

Each poll reads, in order:

1. `/issues?state=all&sort=updated&direction=desc&since=<watermark − 2 min>` (up to
   5 pages; the baseline reads one unfiltered page): `repo.object_created` for unseen
   Issues/PRs (for an Issue also its `bodyHash` and `updatedAt` as sighted, so an edit
   made before the first sighting is not lost: ingest compares it with an open
   conclusion gate), `issue.edited` when the body hash or sorted labels change
   (comments alone never trigger it), and Issue/PR command markers of the viewer.
2. `/issues/comments?sort=updated&since=…` repo-wide: comment markers of the viewer.
   One list request replaces per-Issue comment reads (list lag ≈ 0.5 s, G6).
3. `/pulls?state=all&sort=updated` (paging on only while every PR on a page changed),
   then `/pulls/{n}` for `ai-office/` head PRs whose state, head or base changed, or
   that are open with `mergeable: null` (G3: it returns to null after base moves).
   `pr.state` carries `mergedBy` and `mergeCommitSha` (owner hand-merge, §4.5). The
   baseline reports open PRs only; earlier terminal PRs are recorded silently.
4. Check runs and the combined status for open PR heads until success/failure. "none"
   needs no runs and no statuses: the combined state is `pending` without statuses (G7).
5. `matching-refs/heads/ai-office/` and the default branch ref: `branch.head_changed`
   (the baseline reports every head with `previousSha: null`).

`object.duplicate` is reported when one marker is on two or more of the viewer's
objects and the newest is older than `CREATE_PENDING_WINDOW_MS`, once per set.
Cleanup is the engine's outbox commands (T11). `occurredAt` comes from GitHub
timestamps, except for refs and checks, which have none and use the clock.

The cursor is versioned JSON bounded by `CURSOR_LIMITS`; malformed cursors and
cursors of another repository fail with `validation invalid_cursor`.

Transition keys are chained (FX-C): `pr.state`, `issue.edited`,
`branch.head_changed` and `pr.checks` use `<readable state>:<H(previous key,
state)>`, with the object's previous key (`pr:<n>`, `issue:<n>`, `ref:<branch>`,
`ck:<n>`) kept in the cursor's `k` map. A return to an earlier state (a reopened
PR, a reverted body, a branch moved back, flapping checks) therefore gets a fresh
key instead of being dropped by ingestion as already observed, while replaying a
cursor repeats its keys. `k` holds one key per object the cursor still tracks and
is pruned with it. A cursor written before FX-C has no `k`: its chains start
empty, so no transition is re-emitted (events still come only from the state diff)
and later keys simply carry the suffix.
