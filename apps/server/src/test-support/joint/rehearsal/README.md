# M5-T11 rehearsal (fake runtime + real GitHub, two exact kill windows)

M5_PLAN §2.4. T9's fake-world `m5-mainline` runs in a killable child backend
(`backend-child.ts`, `--dev --fake m5-mainline`). The SCM lives in the
harness process behind `../scm-bridge.ts`: real scm-github on the spike's test
namespace `ai-office/t<runId>` when live, scm-fake in the CI twin. The child
never holds a token. `testOnly.persistFakeWorld` (main.ts, dev-only, default
false) keeps the fake world's checkpoint even with an injected SCM, so the fake
runtime survives `kill -9`.

## Exact windows

`pause.ts` wraps the served SCM. The real call runs to completion, and then the
bridge withholds its reply forever:

| Window | Fires on                                                                      | Then                                                           |
| ------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P1     | the first `createIssue` that succeeded                                        | freeze → kill -9 → same-home, same-port restart                |
| P2     | after P1, the first `mergePR` (its `POST /merges` succeeded) of `mul` / `sub` | freeze → kill -9 → restart; releases the held code-name answer |

Freeze means the child flushes the fake-world checkpoint
(`RunningServer.checkpointFakeWorld`), writes `rehearsal-frozen-<window>` and
blocks its event loop. Nothing changes between the checkpoint and the SIGKILL,
and the child can never record `command.succeeded` for the withheld call.
T7's `RestartControl` allows exactly one kill, so each window gets its own
control, which adopts the running backend.

`windows.ts` judges each window separately: the command was pending at the
kill; after the restart there is exactly one terminal event (`succeeded`),
with `command.reconciled{found|redone}`; it is never issued again; exactly
one Issue with its marker (P1), or exactly one merge commit of the PR plus one
`workitem.merged` with the withheld commit (P2); ready including reconcile is
≤ 60 s. The run stops at the final-PR gate, because that PR targets the spike's
`main` and is never merged (G-D). The T10 checker runs on the log. Rows the
rehearsal cannot judge are n/a with a reason (`REHEARSAL_NA`).

## Running

```sh
pnpm -r build
# CI twin (scm-fake), part of pnpm test:
pnpm exec vitest run apps/server/src/acceptance/joint/rehearsal.acceptance.test.ts --maxWorkers=2
# Live, GB level, only after the coordinator's go (T7 gate: account, quota, live lock):
AIO_REAL_GITHUB=1 AIO_T11_REHEARSAL=1 AIO_GITHUB_RECORD=1 \
  pnpm exec vitest run --project @ai-office/server-github \
  apps/server/src/acceptance/joint/rehearsal.github.test.ts
```

The live run writes a private report to
`~/.ai-office/test-state/t11-rehearsal-<runId>.json`. It holds requests, 304s,
quota before and after, windows, checker summary and leftovers (counts,
booleans and durations only). With `AIO_GITHUB_RECORD=1` and a clean run, it
also writes segment 1, everything before the first kill:
`fixtures/github/2022-11-28/m5-rehearsal.trace.json` (event semantics, which
the CI twin asserts) and `m5-rehearsal.http.json` (sanitized HTTP, evidence
only). Per the M3-T15 ruling, a whole workflow's HTTP order depends on timing,
so segment 1 is compared by event semantics, not by a call-by-call
`ReplayFetch` (a deviation from §2.4's "strict replay" wording, approved by the
coordinator).
