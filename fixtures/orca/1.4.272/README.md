# Orca 1.4.272 upgrade recheck (M5-T1, P3)

Orca auto-upgraded from 1.4.263 (the M3-T14 verification version) to 1.4.272. This
recheck repeats the M3-T14 procedure (`fixtures/orca/1.4.263/README.md`). It ran on
2026-11-24 through the T8 harness, on the dedicated test repository and the approved
`orca-home` folder, serially, with no agents (`AIO_REAL_AGENTS=0`). The test never
restarted Orca, upgraded it, or changed its settings.

**Result: 1.4.272 verified.** Structures match and the contract is green. `supportedRange`
stays `>=1.4.259 <1.5`, which already includes 1.4.272, so it needs no widening.
The agent path was then run once with real agents (see below).

## Steps and results

| Step                                                      | Result                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1. `orca status --json`                                   | `runtime.appVersion: 1.4.272`, `state: ready`.                                                                                   |
| 2. `pnpm orca:record smoke` ×2                            | Both green; ledger 0 each. Same 26-call argv sequence as the 1.4.263 baseline.                                                   |
| 3a. `orca:recheck` 1.4.272 vs 1.4.272                     | "Recording structures match" (exit 0).                                                                                           |
| 3b. `orca:recheck` 1.4.263 vs 1.4.272                     | "Recording structures match" (exit 0). Baseline: `fixtures/orca/1.4.263/smoke.cli-only.json`.                                    |
| 3c. Negative control                                      | A 1.4.272 copy with `appVersion` changed to a number was refused (exit 1).                                                       |
| 4a. Contract replay (`runtime-orca`, `test-support/orca`) | 18 files passed; 317 tests passed.                                                                                               |
| 4b. `pnpm test:orca` (CLI-only, serial), run twice        | 5 files passed, 3 agent files skipped. Smoke, contract CLI probes, composed backend smoke, cwd guard and git-only SCM all green. |
| 5. Leftovers                                              | Every ledger from this session reports 0 remaining; `janitor --scan` reports 0; spike `main` unchanged.                          |

The 1.4.272 smoke recording is committed as `smoke.cli-only.json` (prettier-formatted,
same sanitization as the 1.4.263 file) and passes `pnpm fixtures:scan`.

## Differences observed (all additive)

- `status.runtime.capabilities` gained 59 entries and lost none (for example
  `agent-cli-update.v1`, `usage.analytics.v1`, `orchestration.client-agent-asks.v1`,
  `orchestration.paired-worker-approvals.v1`, `orchestration.peer-mail-types.v1`,
  `orchestration.chat-lineage.v1`, `worktree.create.host-owned-settings.v1`, and
  `bots.*`, `browser.*`, `accounts.*` and `google.*` families). The adapter reads
  none of them.
- Apart from ids, no short enum-like string value changed in any smoke response.
- The response keys of `status`, `terminal create/close/list`, `run-create` and
  `worktree create/rm/list` are unchanged.

## CLI flags on the adapter path (read-only `--help`)

Every flag the adapter passes is still accepted on 1.4.272: `worker-start`
(`--from --agent --model --effort --spec --spec-file --task-title --worktree
--keep-open --run --retry-request`), `send`, `check` (`--terminal --run --wait
--timeout-ms`), `reply`, `inbox`, `worker-list` (`--cursor --limit`), `worker-read`
(`--source --cursor --limit`), `worker-show`, `worker-stop`/`worker-release`
(`--dispatch` only, still no `--from`), `task-list`, `task-update`, `run-create`,
`run-use`/`run-show` (`--id`), `run-list`, `request-show` (`--request`), `terminal
create/list/close`, and `worktree create/rm/list/show`. Help still says "`--effort`
requires `--model`", which matches `workerStartLaunchArgs`.

## Agent path (`pnpm test:orca:agents apps/server/src/adapters/runtime-orca`)

Scoped run with `AIO_REAL_AGENTS=1` (the M2-T17 implement/hybrid flows were left to
M5-T11b): 2 files, 4 tests passed in 257 s; every ledger 0, `janitor --scan` 0.

- Contract agent probes (spawn replay, kept-open follow-up `send`, `check`/`inbox`,
  `worker-show`, spawn-in-flight): green.
- P4 (Claude worker `run-use`): own run rejected with
  `worker_cannot_coordinate_own_run` (with and without `--from`); another run can
  be taken, `identity_hijacked` detected in 656 ms, reclaimed, redactor reports
  `orca-run-use`. Same as M2-T16.
- P5b (Codex worker, terminal mode): keeps `CODEX_THREAD_ID`, `ORCA_PANE_KEY` and
  `ORCA_TERMINAL_HANDLE`; handle and pane key match the `resolveCaller` comparison;
  `codexEnvironmentWarnings()` returns `[]`.

## Limits

- `recheck` compares types and key sets. Additions to string arrays (such as
  `capabilities`) and new enum values are invisible to it; the list above was
  found by hand.

## `repo-list.ok.json` (v0.1.1 repo picker)

The shape of one read-only `orca repo list --json` on 1.4.272, captured on
2026-11-27 for `listLocalRepos`. Keys, types and enum-like values are as
recorded; ids, paths (home as `<home>`), names, usernames, icons and remote URLs
are synthetic and sanitized. The raw capture was not kept. Replayed by
`runtime-orca/contract.test.ts` and `methods/methods.test.ts`.
