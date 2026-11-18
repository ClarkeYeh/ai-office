# Synthetic RuntimePort contract tapes

These are **synthetic**, not live recordings. They were assembled on 2026-11-18
from the T1 Orca 1.4.259 response shapes and T8 Recording/ReplayExec format.
They establish adapter semantics in CI; they do not claim live-runtime evidence.

The shared RuntimePort suite runs unchanged against runtime-fake and the full
runtime-orca assembly (CLI, git, shim identity, ledger, methods and observer).
Each JSON file is an ordered, sanitized tape named by the first 12 hex digits
of SHA-256 of the full Vitest test name. Missing tapes, changed argv, and unused
calls fail. Stimuli alter the wire model and timing, never RuntimePort results.
The normal CI path reads committed tapes; it does not regenerate expectations.
`cases.json` maps filenames to case names. Each tape has named stimulus/advance
segments. Concurrent worker-show/read calls replay in separate per-worker
sequences; mutations and mailbox calls retain strict order.

Source shape references in the parent directory:

- worker-start.codex.keep-open.ok.json
- send.follow-up.codex.ok.json
- check.wait.worker-done.ok.json
- inbox.run.full.ok.json
- worker-list.follow-up-retained.ok.json
- worktree-create.base-sha.ok.json
- worker-stop.already-settled.ok.json
- worker-release.ok.json

Synthetic-only additions include missing receipts, lost responses, timeout,
shim loss/hijack, provider limits, and interleaved pending spawn. Transcript
content is omitted; message bodies are hashes rehydrated by ReplayExec.
Synthetic paths and identities have no relation to the local machine.
The world implements only the tested protocol subset, not an Orca emulator.

To deliberately regenerate after reviewing a protocol change (no live calls):

```sh
AIO_T9_UPDATE=1 pnpm exec vitest run apps/server/src/adapters/runtime-orca/contract.test.ts
pnpm exec prettier --write fixtures/orca/1.4.259/contract/synthetic
pnpm exec vitest run apps/server/src/adapters/runtime-orca/contract.test.ts
pnpm fixtures:scan
```

The extra suffix guard and 60-minute load tests assemble synthetic segments in
memory. The load test uses FakeClock, ten active workers, a 30-second pending
check, and activity changes every 15 seconds; each minute checks the total
budget plus worker-list, worker-read, identity and check distributions.

## Integrator live-recording list (all still missing)

Record ordered contract segments, with explicit stimulus boundaries, for:

1. identity-lost restoration and send after recovery;
2. hijack, guarded mutation, explicit reclaim;
3. check-timeout after consume and unchanged-cursor retry;
4. receipt-absent-after-consume and inbox backfill;
5. response-lost spawn, marker recovery and same-ID retry;
6. spawn-in-flight with worker-list/mail visible before receipt;
7. fresh empty cursors and same-cursor batch replay;
8. provider rate-limit evidence without terminal failure;
9. idempotent session reclaim;
10. pinned workspace creation, replay and request mismatch;
11. remote-only checkoutExisting and pre-created local branch;
12. W1 branch-in-use guard and unexpected suffix cleanup/fallback;
13. retained-worktree rework, release and fresh checkout;
14. spawn replay, marker lookup and spawn request mismatch;
15. stop/release idempotency, stopped without done, retained caller identity;
16. auto-release at two minutes without keep-open;
17. kept-open follow-up with new dispatch and stable AgentRef;
18. question plus false escalation, reply and turn-start-unobserved.

Run live only in the integrator/coordinator session, through T8's origin and
ownership gates. No live cases were run by T9. Supported entry points:

```sh
pnpm test:orca
caffeinate -i pnpm test:orca:agents
pnpm orca:record contract --scenario apps/server/dist/test-support/orca/contract-live-cli.js
pnpm orca:record contract-agents --scenario apps/server/dist/test-support/orca/contract-live-agents.js
```

Supply the harness environment documented in test-support/orca/README.md.
Agent cases collect numeric usage, impose no token limit, and never auto-retry.
Provider-window pauses are reported separately for deferred validation.
The live in-flight probe records concurrent CLI evidence; deterministic pending
ledger assertions belong to replay because live scheduling cannot force a race.

Remaining T17/integrator harness gaps: a prepareWorkspace replay operation, and
CLI-only stop/release without a previously owned dispatch. The agent scenario
checks stop/release on its own real dispatch; it never fabricates ownership.
