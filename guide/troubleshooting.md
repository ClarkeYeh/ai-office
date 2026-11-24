# Troubleshooting

Start with the backend's own message: `ai-office start` prints it just before
`AI Office backend exited during startup.`. Daily logs are in
`<dataDir>/logs/`. Banners in the UI name unhealthy components.

<!-- TODO(M5 final): add the real problems met in the joint runs (M5-T11, T11b, T12). -->

## Startup refusals

| Message (abridged)                                                      | Cause                                                                               | Fix                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `AI_OFFICE_HOME or HOME must be an absolute path`                       | Relative or missing data directory                                                  | Set `AI_OFFICE_HOME` to an absolute path                                                 |
| `Invalid config.toml: TOML syntax error`                                | `config.toml` is not valid TOML                                                     | Fix the syntax                                                                           |
| `Invalid config.toml fields: <paths>`                                   | Unknown key, wrong type or out-of-range value                                       | Correct the listed fields ([Configuration](configuration.md#configtoml))                 |
| `AI Office is already running (pid N, started T)`                       | Another backend holds `data/.lock`                                                  | See [below](#ai-office-is-already-running)                                               |
| `Instance lock recovery in progress; inspect data/.lock.reclaim`        | A previous lock recovery crashed                                                    | Make sure no backend runs, delete `data/.lock.reclaim`, start again                      |
| `Cannot resolve orca binary` / `Cannot resolve gh binary`               | Not on `PATH` or in the known locations (common when started from a GUI or launchd) | Set `orca.bin` / `github.ghBin` to absolute paths                                        |
| `orca.cliConcurrency must be at least 2`                                | Setting too low                                                                     | Use 2 or more                                                                            |
| `orca.supportedRange must use >=x.y.z <x.y[.z]`                         | Malformed range                                                                     | Restore the default `>=1.4.259 <1.5`                                                     |
| `usage.claudeConfigDirs and usage.codexHomes must be absolute paths`    | Relative path in `[usage]`                                                          | Use absolute paths                                                                       |
| `cli-cwd must not be inside orca.homeDir`                               | `orca.homeDir` contains the data directory                                          | Point `orca.homeDir` elsewhere (the default is fine)                                     |
| `orca_version_unsupported`                                              | Orca older than 1.4.259                                                             | Update Orca                                                                              |
| Orca not reachable, or the shim terminal cannot be created              | The Orca app is not running, or the orca-home folder is not registered in Orca      | Start Orca; register the folder ([Prerequisites](prerequisites.md#the-orca-home-folder)) |
| Working directory inside an Orca worktree (`guard`)                     | The data directory is under a folder Orca knows as a project or worktree            | Move the data directory, or remove that registration                                     |
| `GitHub authentication failed; run gh auth login for <login>`           | The owner account is not logged in to `gh`                                          | `gh auth login` as that account                                                          |
| `Set AI_OFFICE_GITHUB_TOKEN to authenticate GitHub`                     | `github.tokenSource = "env"` without the variable                                   | Export the variable, or use `auto`                                                       |
| `scm_login_mismatch`: GitHub login differs from the expected owner      | The active `gh` account, or the token's account, is not the owner                   | `gh auth switch -u <owner>`; check `github.expectedLogin`                                |
| GitHub 401 / bad credentials                                            | Token expired or revoked                                                            | `gh auth refresh`, or replace `AI_OFFICE_GITHUB_TOKEN`                                   |
| `N runtime request(s) are still pending after 30 reconciliation passes` | Orca did not answer recovery queries                                                | Check Orca, then start again                                                             |
| `--fake <scenario> requires --dev`                                      | Fake mode asked for in production                                                   | Add `--dev` and use a separate `AI_OFFICE_HOME`                                          |

If GitHub is merely unreachable or rate-limited at startup, the backend starts
anyway: workflow creation stays disabled until GitHub answers, and health shows
why.

### AI Office is already running

Only one backend may use a data directory. If the pid in the message is a live
AI Office backend, use that one (or stop it with Ctrl-C in its terminal). If
that process is gone, for example after a crash or when the pid now belongs to
something else, start with:

```sh
ai-office start --break-lock
```

Never use `--break-lock` while another backend is really running on the same
data directory: two backends would dispatch the same work twice.

## A repository cannot start workflows (`repo_not_ready`)

Merge commits are disabled on the repository. Enable **Allow merge commits** in
the repository settings. The status refreshes on the next production start.
Other repository warnings are listed in
[Prerequisites](prerequisites.md#repository-settings).

## Workflow paused

A paused workflow dispatches nothing new and resumes by itself.

- **`paused{auth}`**: the active `gh` account no longer matches the owner
  (checked every five minutes). Run `gh auth switch -u <owner>`; the workflow
  resumes on the next check.
- **GitHub rate limit**: the backend waits out the limit and continues.
- **Orca or database unavailable**: a banner names the component. Fix it; the
  workflow resumes when health recovers.

## Orca `unverified`

Orca is newer than `orca.supportedRange`, or its version changed while running
(Orca updates itself). Running workflows continue; new workflows ask you to
confirm once. Only output that no longer matches the expected shape
(`runtime_contract_mismatch`) pauses dispatch. In that case, stay on a
supported Orca version until AI Office is updated.

## Session expired or login link rejected

The login link works once, within 60 seconds. A session lasts 30 days. Run
`ai-office open` for a new link, or restart with `ai-office start`.
([Usage](usage.md#log-in-again); `open` is pending review.)

`ai-office open` reports `Cannot verify a running AI Office instance` when no
backend runs for that data directory. Check `--home` / `AI_OFFICE_HOME`, or
start one.

## After a backend restart

Stopping or crashing the backend does not stop the agents. On the next start
the backend replays its event store, re-arms timers and reconciles with Orca and
GitHub before it serves anything. Agents whose submissions failed while the
backend was down retry them on their own. Nothing needs to be redone by hand.

## Sleep

With `orca.preventSleep = true` (default) the Mac stays awake while a workflow
runs, but closing the lid still sleeps it. After a wake the backend notices
the gap, re-checks Orca and continues. Timers resume with their remaining time.

## Cleanup failed and leftover worktrees

A `cleanup-failed` warning names a worktree or branch the backend did not
remove: usually a worktree with unpushed commits or uncommitted changes, which
it never deletes. Inspect the worktree in Orca; push or discard the work; then
press **Cleanup** on the workflow again. Worker branches can also be deleted
on GitHub by hand; only delete branches under `ai-office/<id>/`.

Worktrees left from an old workflow without automatic cleanup: press
**Cleanup** on that workflow.

(`cleanup-failed` and automatic cleanup are pending review.)

<!-- TODO(M5-T3): drop the pending remark after merge. -->

## Codex warning `codex_env_filtered`

Your Codex `shell_environment_policy` strips variables agents need. See
[Prerequisites](prerequisites.md#codex-shell_environment_policy).

## Usage shows unavailable

Session logs were not found, or their format changed. Check
`usage.claudeConfigDirs` / `usage.codexHomes` if your agents use non-default
configuration directories. Budgets then fall back to substitute limits.
