# Configuration

## Data directory

Everything AI Office keeps lives in one data directory, `<dataDir>`:

- `~/.ai-office` by default;
- `$AI_OFFICE_HOME` when set (must be an absolute path).

Use a separate `AI_OFFICE_HOME` for experiments so they never mix with your real
history. Fake and development runs always use their own directory.

| Path                       | Contents                                                              |
| -------------------------- | --------------------------------------------------------------------- |
| `config.toml`              | Your settings (optional; every key has a default)                     |
| `templates/*.yaml`         | Workflow templates, editable                                          |
| `data/ai-office.sqlite`    | Event store and read models                                           |
| `data/.lock`               | Single-instance lock (`{pid, startedAt}`)                             |
| `data/specs/`              | Per-attempt agent instructions (mode 0600, deleted when attempts end) |
| `data/control.token`       | Local control token for `ai-office open` (mode 0600; pending)         |
| `runtime.json`             | `{port, pid, startedAt}` of the running backend, for the CLI          |
| `logs/server-YYYYMMDD.log` | Daily logs, kept 14 days                                              |
| `cli-cwd/`                 | Working directory for `orca` and `gh` subprocesses                    |
| `orca-home/`               | Default Orca folder workspace for the shim terminal                   |

Directories are created with mode 0700. Only one backend may use a data
directory at a time.

> **Pending:** `data/control.token` comes with `ai-office open` (in review).
> Another pending change stops creating `orca-home/` when `orca.homeDir` points
> elsewhere.

<!-- TODO(M5-T5/T6): remove the pending note after merge. -->

## `config.toml`

`<dataDir>/config.toml` is TOML, validated strictly: unknown keys and wrong
types refuse startup. The error lists only the offending field paths, never
their values. A missing file means all defaults. Restart the backend after
editing.

A complete file with the defaults:

```toml
[server]
port = 4319

[orca]
bin = "orca"
homeDir = ""
supportedRange = ">=1.4.259 <1.5"
shimLocation = "folder-workspace"
shim.closeOnExit = false
cliConcurrency = 4
maxCallsPerMinute = 120
preventSleep = true

[engine]
spawnStallMs = 600000

[budget]
enforcement = "on"

[usage]
claudeConfigDirs = []
codexHomes = []
budgetFormula = "inputUncached + output + cacheWrite"

[github]
tokenSource = "auto"
ghBin = ""
expectedLogin = ""

[env]
passthrough = ["GH_CONFIG_DIR", "XDG_CONFIG_HOME"]

[limits]
globalAgents = 10

[retention]
workerBranches = "delete-on-complete"
```

### server

| Key           | Default | Meaning                                                                                                                                    |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.port` | `4319`  | Port on `127.0.0.1` (the UI is at `http://127.0.0.1:4319`). `ai-office start --port <n>` overrides it for one run (`0` picks a free port). |

### orca

| Key                      | Default              | Meaning                                                                                                                                                                                             |
| ------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orca.bin`               | `"orca"`             | `"orca"` searches the absolute entries of `PATH`, then `/Applications/Orca.app/Contents/Resources/bin/orca`. Otherwise an absolute path.                                                            |
| `orca.homeDir`           | `""`                 | Absolute path of the folder workspace holding the shim terminal. Empty means `<dataDir>/orca-home`. You must register it in Orca yourself ([Prerequisites](prerequisites.md#the-orca-home-folder)). |
| `orca.supportedRange`    | `">=1.4.259 <1.5"`   | Orca versions treated as verified. Must have the form `>=x.y.z <x.y[.z]`. Below: refuse to start. Above: `unverified`.                                                                              |
| `orca.shimLocation`      | `"folder-workspace"` | `folder-workspace` or `repo-main-worktree` (fallback: shim in the repository's main worktree).                                                                                                      |
| `orca.shim.closeOnExit`  | `false`              | Close the shim terminal when the backend stops. By default it is kept and reused after a restart.                                                                                                   |
| `orca.cliConcurrency`    | `4`                  | Parallel `orca` subprocesses. At least 2: one slot is reserved for commands while long polls wait.                                                                                                  |
| `orca.maxCallsPerMinute` | `120`                | Rate limit for `orca` calls (CPU budget).                                                                                                                                                           |
| `orca.preventSleep`      | `true`               | Keep the Mac awake (`caffeinate -i`) while workflows run. Closing the lid still sleeps.                                                                                                             |

### engine

| Key                   | Default  | Meaning                                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `engine.spawnStallMs` | `600000` | Spawn-stall threshold (10 minutes). An agent with no activity and no submission for two thresholds opens a `spawn-stall` gate. |

### budget

| Key                  | Default | Meaning                                                                                                                                                                                      |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.enforcement` | `"on"`  | `on`: stage and workflow token budgets open exception gates, and hard limits stop agents. `off`: usage is still measured and shown, the UI shows the budget as disabled, nothing is stopped. |

On a subscription plan, where tokens are not billed per use, `off` is a
reasonable choice. Each workflow records the setting at its start.

<!-- TODO(M5-T13): add calibrated budget numbers and guidance from the real-scale run. -->

### usage

Token usage is read from the agents' local session logs.

| Key                      | Default                                 | Meaning                                                                                                   |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `usage.claudeConfigDirs` | `[]`                                    | Extra absolute Claude config directories to search, in addition to `~/.claude` and the ones Orca reports. |
| `usage.codexHomes`       | `[]`                                    | Extra absolute `CODEX_HOME` directories, in addition to `~/.codex` and Orca's Codex runtime home.         |
| `usage.budgetFormula`    | `"inputUncached + output + cacheWrite"` | What counts against budgets. Cache reads are not counted by default.                                      |

### github

| Key                    | Default  | Meaning                                                                                                                                                                                                    |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.expectedLogin` | `""`     | The owner's GitHub login. Empty: the owner of the first registered repository, then the active `gh` account. Setting it is recommended; the active `gh` account must match it.                             |
| `github.tokenSource`   | `"auto"` | `auto`: `AI_OFFICE_GITHUB_TOKEN` if set, else `gh auth token --user <owner>`. `env`: only `AI_OFFICE_GITHUB_TOKEN`. `gh`: only `gh`.                                                                       |
| `github.ghBin`         | `""`     | Empty: search the absolute entries of `PATH`, then `/opt/homebrew/bin/gh` and `/usr/local/bin/gh`. Otherwise an absolute path. Set it when starting from a GUI or launchd, where `PATH` may lack Homebrew. |

The token is kept only in memory. On a 401 the backend re-reads it at most once
every five minutes, so `gh auth refresh` is picked up without a restart.

### env

| Key               | Default                                | Meaning                                                                                                                                                                                                                |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.passthrough` | `["GH_CONFIG_DIR", "XDG_CONFIG_HOME"]` | Extra environment variables passed to `gh` and `git fetch` subprocesses only, never to `orca`. Names starting with `ORCA_`, `CLAUDE`, `CODEX_`, `AI_OFFICE_`, `GITHUB_` or `GH_` (except `GH_CONFIG_DIR`) are ignored. |

Every subprocess otherwise sees only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`,
`LC_ALL` and `TMPDIR` ([Safety](safety.md#backend-identity-in-orca)).

### limits

| Key                   | Default | Meaning                                  |
| --------------------- | ------- | ---------------------------------------- |
| `limits.globalAgents` | `10`    | Maximum agents running at the same time. |

### retention

| Key                        | Default                | Meaning                                                                                                                                                                          |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention.workerBranches` | `"delete-on-complete"` | `delete-on-complete`: when a workflow completes, its worker worktrees and `ai-office/<id>/...` worker branches are removed automatically. `keep`: leave them; clean up manually. |

The integration branch and the default branch are never deleted. Each workflow
records the setting at its start.

> **Pending:** the automatic cleanup on completion, the `keep` value and the
> `cleanup-failed` warning are in review. Until they merge, only
> `"delete-on-complete"` is accepted and cleanup is manual
> ([Usage](usage.md#cleanup)).

<!-- TODO(M5-T3): remove the pending note after merge. -->

## Environment variables

| Variable                 | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `AI_OFFICE_HOME`         | Data directory (absolute). Default `~/.ai-office`.                              |
| `AI_OFFICE_GITHUB_TOKEN` | GitHub token used instead of `gh` when `github.tokenSource` is `auto` or `env`. |
| `CODEX_HOME`             | Where AI Office looks for Codex's `config.toml` and session logs.               |

## Templates

A template defines the roles (which agent kind plays each role and what it is
responsible for), the stages, their budgets and timeouts, and which gates can be
switched off.

- Templates live in `<dataDir>/templates/*.yaml` and are read again on every
  request, so edits apply to the next workflow without a restart.
- On start, the built-in `feature-to-pr.yaml` is copied there **only if no
  file with that name exists**. Your edits are never overwritten.
- Invalid files are listed on the Templates page with the field path and
  error. The other templates keep working.
- To create a variant, copy `feature-to-pr.yaml` to a new file and change its
  `id` and `name`.

The built-in template has these roles:

| Role         | Agent         | Responsibility                                                     |
| ------------ | ------------- | ------------------------------------------------------------------ |
| `lead`       | `claude-code` | Facilitates the meeting, splits work, answers implementers on call |
| `pm`         | `claude-code` | Requirements, scenarios, acceptance criteria                       |
| `architect`  | `claude-code` | Architecture and technology choices                                |
| `engineer`   | `codex`       | Implements work items with tests                                   |
| `integrator` | `claude-code` | Reviews worker PRs in the merge queue, final integration           |

### Upgrading templates

Because the copy is made only once, a newer built-in template does not replace
yours. To pick it up, rename or delete your `templates/feature-to-pr.yaml` and
restart; the new built-in is copied in. Then reapply your edits. The source is
`packages/templates/feature-to-pr.yaml` in the checkout.

<!-- TODO(M5 final): template upgrade notes for v0.1 changes (budgets from M5-T13). -->
