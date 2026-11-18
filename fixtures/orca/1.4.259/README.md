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
