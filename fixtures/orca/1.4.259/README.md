# Orca 1.4.259 recordings (M2-T1)

Hand-recorded CLI responses from the day-1 verification of M2 P1, P2a and P6–P9,
taken against the dedicated test repository and the test run only. Files named
`after-restart.*` were recorded after an Orca app restart.

## Format (provisional until M2-T8)

Each file is `{orcaVersion, recordedAt, argv, exitCode, response, stderrLines[, note]}`.
`stdout`/`stderr` are deliberately not used as keys because the sanitizer summarizes
those values in full. Values of `--body`, `--prompt`, `--spec-file`, `--question` and
`--objective` in `argv` are replaced by `<redacted:test-input>`.

## Normalization

- Output of `scripts/fixtures/sanitize`, then manual normalization:
  every UUID (terminal handles, pane keys, repo ids, request ids, runtime ids,
  incarnations) maps consistently across files to `00000000-0000-4000-8000-<n>`.
- Home directories appear as `<home>`; worktree paths collapsed by the sanitizer
  appear as `<home>/<redacted>`.
- Short Orca ids (`run_`, `ctx_`, `task_`, `msg_`) and `@@<8 hex>` pty suffixes are kept.
- Sanitizer side effects to expect when writing schemas: every `body` becomes a
  length plus SHA-256, `deliveryId` values become `<redacted>`, and owner names in
  `projectId` are masked.
- `worker-read` responses contain transcript text and are not recorded.

## Findings that shape adapter code

- `send` to a keep-open worker creates a new task and dispatch (`delivery: follow_up`,
  `followUpOf`); the new task title is the `--subject`.
- After `ask`, `agentWait` is `null`; detect waiting input from unanswered questions.
- Consuming `check` messages carry no `sequence`; take cursors from `inbox`.
  A `check` batch may include message types beyond `--types`.
- Replayed `check` is signalled by `mutation.replayed`, not `result.replayed`.
- `worker-start` can exit 1 with `ok: true` and `state: failed`.
- `consumer_fenced` message text is shared across commands; rely on `error.code`.
- A remote-only branch name counts as taken: `worktree create --branch W` yields `W-2`
  (path suffixed too) with no warning. Always trust the receipt's `branch`/`path`.
- A local branch name used as a base resolves to the local, possibly stale, commit;
  base on a fetched SHA.
- Restarting the Orca app kept terminals, the run binding and worker processes alive,
  because terminals are hosted by a separate daemon.

# M2-T16 live verification (2026-11-18, Orca 1.4.259)

Run by the M2-T16 worker through the T8 harness on the dedicated test repository,
serially, with an isolated `AI_OFFICE_HOME` and the approved `orca-home` folder.
Every run ended with ledger 0 and scan 0, no `ai-office-test/*` or `aio-test-*`
branches (local or remote), and the test repository's `main` unchanged.
Only error codes, booleans and key names were kept; no receipts or transcript
text are reported beyond the two fixtures below.

| Item                                      | Result                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| P2b (restart during the full flow)        | **Not tested.** Skipped by owner decision; P2a (app restart) passed on day 1.  |
| P3 (upgrade compatibility)                | Procedure rehearsed on the same version; no upgrade was triggered.             |
| P4 (`run-use` from a worker)              | Own run rejected; another run **can be taken**, and is detected and reclaimed. |
| P5a (Codex env matrix, outside Orca)      | Matrix below; the T11 prediction was corrected to match it.                    |
| P5b (Orca Codex worker, current settings) | `ORCA_*` kept; identity double check passed.                                   |
| P5c                                       | Skipped (no disposable Orca).                                                  |

## P3: upgrade recheck procedure

Installed and running version: 1.4.259. The updater's pending archive is the same
version, so no newer build is staged. `supportedRange` stays `>=1.4.259 <1.5`.
After a natural upgrade (never triggered by tests):

1. `orca status --json`: read `runtime.appVersion`.
2. `pnpm orca:record smoke` (plus `--scenario` contract/P4/P5b for broader shapes).
3. Put the old and new recordings under the same file name in two directories,
   then run `pnpm orca:recheck --previous <old> --current <new>`.
4. `pnpm test` (contract replay) and `pnpm test:orca` (CLI-only, serial).
5. Green and outside `supportedRange`: open a PR widening it and adding
   `fixtures/orca/<version>/` after sanitizer review and `pnpm fixtures:scan`.

Rehearsal: two smoke recordings on 1.4.259 → "Recording structures match". A
copy with one field's type changed → refused (exit 1). A real upgrade check stays
a to-do before M3 starts.

## P4: worker `run-use`

A Claude worker in run RA ran `orca orchestration run-use --id <run> --json`, with
and without `--from "$ORCA_TERMINAL_HANDLE"`, against RA and against RB (another
harness run with its own shim):

- RA (own run): rejected both ways, `error.code: worker_cannot_coordinate_own_run`.
- RB (not its run): **accepted** both ways. `coordinator_handle` became the worker
  terminal and `consumer_generation` went from 1 to 2 (`run-show.hijacked-by-worker.ok`).
- The production `ShimCoordinatorIdentity.checkOwnership` queued
  `runtime.identity_hijacked` for RB in under 1 s (limit 30 s). RA stayed `owned`.
- `reclaimSession(RB)` ran `run-use` from shim B, moving the generation from 2 to 3
  (`run-use.reclaim-after-worker-hijack.ok`); ownership was `owned` again.
- The production redactor, given the worker session's tool calls in memory,
  reported `orca-run-use`.

Design consequence (M2_PLAN §5 P4 failure branch): defenses stay layered (spec
ban, policy hit, hijack detection). SPEC §21's residual risk becomes "tested:
a worker can take another run". Promoting `orca-run-use` to an immediate stop of
that worker is proposed as a follow-up.

## P5a: Codex `shell_environment_policy` matrix

`codex-cli 0.167.1`, `codex exec --sandbox read-only` in a scratch directory,
outside Orca, with fake `ORCA_TERMINAL_HANDLE` and `ORCA_PANE_KEY`. Each case
overrides one setting with `-c` on top of the owner's config, whose
`shell_environment_policy` has only a `set` table. Keys were read from the
command's actual output, not the model's reply.

| Override                          | `ORCA_*` seen                                                                 | T11 prediction (after fix)      |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| none (owner config: `set` only)   | both                                                                          | not filtered ✅ (was: filtered) |
| `inherit = "all"`                 | both                                                                          | not filtered ✅                 |
| `inherit = "core"`                | none                                                                          | filtered ✅                     |
| `inherit = "none"`                | none (not even PATH)                                                          | filtered ✅                     |
| `exclude = ["ORCA_*"]`            | none                                                                          | filtered ✅                     |
| `include_only = ["PATH","HOME"]`  | none                                                                          | filtered ✅                     |
| `ignore_default_excludes = true`  | both                                                                          | not filtered ✅                 |
| `ignore_default_excludes = false` | `ORCA_TERMINAL_HANDLE` only (`*KEY*` default exclusion drops `ORCA_PANE_KEY`) | filtered ✅ (was: not filtered) |

## P5b: Orca Codex worker under current settings

Receipt `mode: terminal`. The worker saw `CODEX_THREAD_ID`, `ORCA_PANE_KEY` and
`ORCA_TERMINAL_HANDLE`. Its handle matched `worker-list` and its pane key matched
`worker-show` `dispatch.assigneePaneKey`, the same comparison `resolveCaller`
makes. `codexEnvironmentWarnings()` on the owner's config returned `[]`.

## Usage (calibration only; no cap)

| Run                            | Provider    | Input (incl. cache)         | Output |
| ------------------------------ | ----------- | --------------------------- | ------ |
| P4, first run                  | Claude Code | 299,730                     | 1,232  |
| P4, re-run (verdict persisted) | Claude Code | 351,598                     | 1,666  |
| P5b                            | Codex       | 123,389                     | 486    |
| P5a, 8 `codex exec`            | Codex       | 338,319 (281,472 cached) | 466    |
