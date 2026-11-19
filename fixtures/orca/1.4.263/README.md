# Orca 1.4.263 upgrade recheck (M3-T14, P3)

Orca auto-upgraded from 1.4.259 (the M2 verification version) to 1.4.263. This is
the first real run of the P3 procedure rehearsed in M2-T16
(`fixtures/orca/1.4.259/README.md`). It ran on 2026-11-19 through the T8 harness,
on the dedicated test repository and the approved `orca-home` folder, serially,
with no agents (`AIO_REAL_AGENTS=0`). The test never restarted Orca, upgraded it,
or changed its settings.

**Result: 1.4.263 verified.** The structures match and the contract is green.
`supportedRange` stays `>=1.4.259 <1.5`, which already includes 1.4.263, so it
needs no widening.

## Steps and results

| Step                                                      | Result                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1. `orca status --json`                                   | `runtime.appVersion: 1.4.263`, `state: ready`.                                                                                   |
| 2. `pnpm orca:record smoke` ×2                            | Both green; ledger 0, scan 0 each.                                                                                               |
| 3a. `pnpm orca:recheck` 1.4.263 vs 1.4.263                | "Recording structures match" (exit 0).                                                                                           |
| 3b. `pnpm orca:recheck` 1.4.259 vs 1.4.263                | "Recording structures match" (exit 0). Baseline: a 1.4.259 smoke recording with the same argv sequence, from M2 (2026-11-18).    |
| 3c. Negative control                                      | A 1.4.263 copy with `appVersion` changed to a number was refused (exit 1).                                                       |
| 4a. Contract replay (`runtime-orca`, `test-support/orca`) | 18 files passed, 5 live files skipped; 303 tests passed, 7 skipped.                                                              |
| 4b. `pnpm test:orca` (CLI-only, serial), run twice        | 5 files passed, 3 agent files skipped. Smoke, contract CLI probes, composed backend smoke, cwd guard and git-only SCM all green. |
| 5. Leftovers                                              | Every ledger from this session reports 0 remaining; `janitor --scan` reports 0; spike `main` unchanged.                          |

The 1.4.263 smoke recording is committed as `smoke.cli-only.json`, so the next
upgrade has an in-repo baseline for step 3. It was sanitized like the 1.4.259 files,
and it passes `pnpm fixtures:scan`.

## Differences observed (all additive)

- `status.runtime.capabilities` gained 11 entries and lost none:
  `settings.agent-permission.seed.v1`, `agent.launch.pi-model.v1`,
  `agent.launch.plain-session-id.v1`, `agent.launch.setup-trust-mismatch.v1`,
  `agent-session.mcp.v1`, `agent-session.skip-async-questions.v1`,
  `agent-session.prompt-suggestions.v1`, `projectGroup.folder-archive.v1`,
  `terminal.send-approval-guard.v1`, `browser.tab-history-state.v1` and `git.blame.v1`.
  The adapter reads none of them.
- The response keys of `status`, `terminal create/close/list`, `run-create` and
  `worktree create/rm/list` are unchanged.

## CLI flags on the agent path (read-only `--help`)

The CLI-only smoke does not exercise the agent commands, so their 1.4.263 help was
checked against every flag the adapter passes. All of them are still accepted:
`worker-start` (`--agent --model --effort --spec-file --task-title --worktree
--keep-open --run --from --retry-request`), `send`, `check` (`--terminal --run
--wait --timeout-ms`), `reply`, `inbox`, `worker-list` (`--cursor --limit`),
`worker-read` (`--source --cursor`), `worker-show`, `worker-stop`/`worker-release`
(`--dispatch` only, still no `--from`), `task-list`, `task-update`,
`run-use`/`run-show` (`--id`) and `request-show` (`--request`). Help still says
"`--effort` requires `--model`", which matches `workerStartLaunchArgs`.

## Not covered

- Agent-driven shapes (`check`/`inbox` messages, `worker-show`, follow-up `send`,
  P4, P5b) were not re-recorded, because this recheck uses no agents.
  `pnpm test:orca:agents` and the M3-T17 smoke run will exercise them on 1.4.263.
  codex-cli is still 0.167.1, so P5a needs no rerun.
- `recheck` compares types and key sets. Additions to string arrays (such as
  `capabilities`) and new enum values are invisible to it.
