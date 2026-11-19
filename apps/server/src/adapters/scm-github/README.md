# GitHub transport base (M3-T3)

`createGithubScm(options)` currently returns `{ http, repoAllowlist, diagnostics }`.
T4 owns composition of ScmPort methods; T5 adds PR methods and T6 adds polling.
No ScmPort methods are stubbed as successful. This base does not execute processes.

Inject `fetch` (the native fetch signature) for recording/replay, `clock.now(): Date`
and `sleep(ms)` for deterministic scheduling, `tokenProvider({refresh})`, and
`maskSecrets` from the existing Redactor port. Production composition supplies
`readGhToken` from config; tokens remain in memory. There is no logger. The first
401 reloads once; subsequent reload attempts are spaced at least five minutes.

`RepoAllowlist` accepts `{owner, name}` registered repositories. `inspect(repo, fn)`
scopes temporary read access to registration; call `register(repo)` only after
registration succeeds. All reads and writes recheck access when dequeued.

`http.request(endpointId, params, {schema, conditional?, safety?})` returns
`{data, status, notModified, etag?, nextPage?}`. Endpoint IDs and write schemas live
in `policy/endpoints.ts`; arbitrary URLs and redirects are rejected. `params`
contains path variables (`owner`, `repo`, `number`, `id`, `ref`, `branch`, `base`,
`head`, `sha`), `query`, and `body`. Branch path variables are encoded once.

Use `z.looseObject` for response schemas: require consumed fields and accept
additive fields. `paginate` accepts an array schema, fixes `per_page` to 100 by
default (50 is also supported), and follows only increasing page numbers on the
same authorized URL. It rejects changed origins, paths, filters, and cycles.

Conditional reads cache parsed values by complete URL. `conditional: true` uses
the cached ETag; a string pins a poll cursor's ETag. A 304 requires a matching
cached representation. Poll cursors must retain their own state; an old cursor
ETag normally yields 200 after the shared cache has advanced. Writes invalidate
the cache, including ambiguous writes. Cache entries and metrics are bounded.

Method implementations must fetch fresh safety evidence (`conditional: false`)
immediately before destructive writes. Supply `safety.defaultBranch` and
`safety.protected: false` for ref deletion; `viewer`, `author`, `body`, `commandId`
for comment deletion; `defaultBranch`, `actualBase`, `protected: false` for
`POST /merges`; and the fetched
`body` for PR closure. The HTTP layer checks that evidence; method layers own
fetching it and the required pre/post-merge checks. The base cannot establish
remote ownership from caller-supplied evidence by itself.

Read concurrency is four. Writes are serialized with at least one second between
starts; Issue, PR, and comment creation is capped at twenty per rolling minute.
Primary throttling blocks reads and writes; secondary throttling blocks its
request class. Blocked requests return `rate_limited` with remaining wait time.
An exhausted primary budget on a successful response also blocks requests.
Concurrent responses never shorten an active cooldown. Remaining quota uses a
conservative minimum across interleaved counters until the current reset window
expires; reset timestamps and HTTP-date retry delays are corrected for the
observed server clock offset. A clean response resets secondary fallback backoff
without clearing an active cooldown.
No breaker is owned by this adapter: diagnostics report throttling as degraded,
never unhealthy. T9 applies polling thresholds and keeps rate limits out of the
transient circuit breaker counter.

Issue/comment transport failures and 5xx return `create_outcome_unknown` with
15 seconds of `retryAfterMs`; they are never automatically replayed. T4 owns the
command marker pending window. A 422 retains only `alreadyExists` for method
reconciliation, not raw GitHub error details. Error text passes through injected
secret masking after exact token/request-value removal, before truncation.

All tests here use synthetic injected transports. Live testing belongs to the
coordinator/test harness under M3 safety gates; this task does not call live APIs.

## PR methods and merge guards (M3-T5)

`createPrMethods({http}, {sleep?})` in `methods/pulls.ts` provides `openPR`,
`getPR`, `updatePR`, `closePR`, `mergePR` and `listReviewComments`;
`createGithubScm` assembles them into the ScmPort (sharing the HTTP `sleep`). `openPR` appends the command marker and requires an
`ai-office/` head; a 422 duplicate (G10) adopts the open PR for the same
head/base only when it carries this command's marker. `updatePR` sends title,
body and state only (never the base); closing re-reads the PR fresh and requires
an AI Office marker.

`mergePR` reads the PR, the repository and the base branch fresh, then refuses
(`guard`) a base equal to the default branch, outside `ai-office/`, or with
`protected: true`, and any method other than `merge`. A head other than
`expectedHeadSha` is non-retryable `head_mismatch`; a base head other than
`expectedBaseSha` is `base_moved`. `expectedBase` (the branch from our record)
becomes the merged base; a PR whose base differs is non-retryable
`conflict base_mismatch` and is never merged. An already merged PR returns its merge commit
(G4). The merge is `POST /merges {base, head: expectedHeadSha}` (S20): the base
is named from the fresh read, so a PR retargeted meanwhile cannot redirect it.
201 and 204 (head already in base) both continue to the read-back; 409 is
`conflict not_mergeable`. The read-back short-polls the PR with backoff for up to
10 s (G11: GitHub flags it merged ~3 s later): `base.ref` other than the merged
base raises `guard merge_base_changed` (not `base.sha`, the PR-open snapshot),
and a PR never flagged merged raises `guard pr_not_marked_merged`. There is no
`PUT pulls/{n}/merge` endpoint, so no fallback that follows the PR's live base.
Timeouts surface as retryable `github_unavailable`: a retried merge finds the PR
merged or gets 204, and a retried create gets the 422 duplicate.
