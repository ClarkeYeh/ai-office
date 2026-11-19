# GitHub mainline (M3-T15a)

`githubMainlineScenario()` creates a fresh scenario for each fake world. It uses
the public DSL unchanged: two items (`dependent` depends on `feature`), one worker
question answered by on-call, one same-PR feature rework, one failed dependent
review, and one wrap-up fix-forward push before the final PR. The owner/test driver
must choose `retry` at the dependent item's `merge-blocked` gate. This produces
the `-a2` branch and lets the engine close/link the superseded PR. The failure is a
review failure, not a simulated dead worker (which would fail before a PR exists).

## T12 assembly handoff (main.ts remains owned by T12)

1. Register `github-mainline` in the fake scenario allowlist and instantiate
   `githubMainlineScenario()` per world, not once in a global scenario registry.
2. Wrap the live adapter with `scopeGithubScm(adapter, runId, shortId)` from
   `test-support/github/scoped-scm.ts`. Engine command IDs use workflow ULIDs;
   this wrapper prefixes markers/titles for T7, maps marker lookups and duplicate
   events back to engine IDs, and preserves real GitHub bodies/hashes/URLs.
   Accept this injected `ScmPort` for fake-mode assembly (`testOnly.scm`); route both
   engine SCM calls and runtime `remoteHead` to that same instance. Keep existing
   fake scenarios and their persistence behavior unchanged. Do not checkpoint a
   real SCM instance with FakeScm snapshot/restore methods.
3. Construct `createGithubWorldBridge({scm, repo, runId, shortId, pusher})` from
   `test-support/github/fake-world-bridge.ts`. Pass its `onPush`, `remoteHead`, and
   `refreshHeadAfterPush` fields into `createFakeRuntime`. The optional runtime
   flag refreshes local tips and the next push base from SCM after the pusher
   succeeds; illustrative scenario SHAs are never used as real GitHub commits.
4. T15 opens T7's gated/locked harness and creates `GitPusher` with that harness's
   ledger/gate. All SCM HTTP traffic must use `harness.fetch`, so intent is
   persisted before mutation. Supply the same workflow shortId to both wrappers
   (inject a fixed valid `IdGen.shortId()` for the single test workflow). Contract
   shortIds allow only 4–12 characters, so `t<12hex>` cannot be used directly.
   The wrappers map `ai-office/<shortId>/…` and `ai-office/<shortId>-…` to
   `ai-office/t<runId>/…` and `ai-office/t<runId>-…` at the remote boundary, and
   map observed branch names back. The engine retains its original shortId and
   ULID workflowId. This bridge creates no production claims. Only one workflow
   uses each harness/runId; reconstruct both wrappers with the same IDs on restart.
5. Wire local repo inspection to the spike clone and its runtime repo ID. Keep
   submitter/spec-store wiring in main.ts. Disable simulated owner final merge
   for the injected SCM. T15 must stop at the final PR gate, never merge to main.
6. Always close the pusher and run harness cleanup/assertClean in finally,
   retaining the live lock through cleanup. Pusher commits retain T7's fixed
   noreply identity. Live execution belongs to T15/the integrator.

CI runs this scenario through the existing composed-backend acceptance harness
with scm-fake; it does not need GitHub credentials. Bridge unit tests inject
SCM and a pusher. Credential tightening and production-claim scanning remain
with T8; this bridge creates no production claims.
