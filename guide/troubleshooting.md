# Troubleshooting

Start with the backend's own message: `ai-office start` prints it just before
`AI Office backend exited during startup.`. Daily logs are in
`<dataDir>/logs/`. Banners in the UI name unhealthy components.

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

### A stray old backend blocks startup

An old backend that was never stopped (a terminal closed without Ctrl-C, an
earlier `AI_OFFICE_HOME`) keeps its lock and its port. The new start then
reports `AI Office is already running (pid N, …)`, or exits during startup
because port 4319 is in use. Find the old process, check that it really is an
old AI Office backend, and stop it:

```sh
lsof -nP -iTCP:4319 -sTCP:LISTEN   # who holds the port (use your port)
ps -p <pid> -o pid=,command=       # confirm it is apps/server/dist/main.js
kill <pid>                         # SIGTERM: the backend shuts down cleanly
```

Then run `ai-office start` again. Use `--break-lock` only when the pid in the
message no longer exists ([above](#ai-office-is-already-running)). Agents keep
running while no backend is up; the new backend reconciles with them
([After a backend restart](#after-a-backend-restart)).

### Wrong Node.js version

`brew upgrade` can move the default `node` to version 26. That build can fail
before running anything, with `dyld: Library not loaded: …/libsimdjson…`, and
the repository pins Node.js 24 anyway. Use the pinned major version:

```sh
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"   # add to your shell profile
node --version                                       # v24.x
pnpm install --frozen-lockfile && pnpm build
```

A version manager that reads `.nvmrc` or `.node-version` works too.

### The `gh` account is not the owner

`scm_login_mismatch` at start, or `paused{auth}` later, means the active `gh`
account is not the repository owner. For this project's own repositories the
owner is `ClarkeYeh`; elsewhere it is whoever owns the registered
repositories (or `github.expectedLogin`). Check with `gh auth status` and
switch yourself with `gh auth switch -u <owner>`. AI Office never switches
accounts.

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
`ai-office open` for a new link, or restart with `ai-office start`
([Usage](usage.md#log-in-again)).

`ai-office open` reports `Cannot verify a running AI Office instance` when no
backend runs for that data directory. Check `--home` / `AI_OFFICE_HOME`, or
start one.

## After a backend restart

Stopping or crashing the backend does not stop the agents. On the next start
the backend replays its event store, re-arms timers and reconciles with Orca and
GitHub before it serves anything. Agents whose submissions failed while the
backend was down retry them on their own. Nothing needs to be redone by hand.

## Sleep, heat and power

With `orca.preventSleep = true` (default) the backend holds `caffeinate -i`
while a workflow runs, so the Mac does not idle-sleep. That is not enough on
its own for a long run:

- **Keep the lid open.** Closing it still sleeps the Mac, and every agent stops
  with it.
- **Stay on AC power.** On battery, low-power mode and battery sleep can still
  suspend the machine, and agents slow down.
- **Watch the heat.** Several agents at once keep the CPU busy for hours. A
  hot Mac throttles, and stages take noticeably longer (a timeout nudge may
  follow). Give it airflow; do not run it on a soft surface.

After a wake the backend notices the gap, re-checks Orca and continues. Timers
resume with their remaining time.

## "Worker stopped" and "waiting" notices

Orca prints notices of its own in agent terminals and in its UI, such as a
worker being stopped or an agent waiting. They are benign: an agent that has
submitted its result is stopped on purpose, and an agent between turns waits.
AI Office decides from its own state, not from these notices; Orca's automatic
notices are never taken as an answer to a question. Act only on what the AI
Office UI shows (gates, questions, banners).

## Merge-queue agent idle after a restart

After a backend restart, the merge-queue agent (the `integrator` in the
built-in template) can sit idle with worker PRs waiting. No action is needed:
when `reviewTimeoutMin` (20 minutes in the built-in template) passes, the
backend nudges it with a review-timeout reminder and it picks the queue up
again. The nudge shows on the workflow's **Timeline**.

## Cleanup failed and leftover worktrees

A `cleanup-failed` warning names a worktree or branch the backend did not
remove: usually a worktree with unpushed commits or uncommitted changes, which
it never deletes. Inspect the worktree in Orca; push or discard the work; then
press **Cleanup** on the workflow again. Worker branches can also be deleted
on GitHub by hand; only delete branches under `ai-office/<id>/`.

Worktrees left from an old workflow without automatic cleanup: press
**Cleanup** on that workflow.

## Codex warning `codex_env_filtered`

Your Codex `shell_environment_policy` strips variables agents need. See
[Prerequisites](prerequisites.md#codex-shell_environment_policy).

## Usage shows unavailable

Session logs were not found, or their format changed. Check
`usage.claudeConfigDirs` / `usage.codexHomes` if your agents use non-default
configuration directories. Budgets then fall back to substitute limits.
