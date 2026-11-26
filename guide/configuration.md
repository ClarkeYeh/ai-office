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
| `data/control.token`       | Local control token for `ai-office open` (mode 0600)                  |
| `runtime.json`             | `{port, pid, startedAt}` of the running backend, for the CLI          |
| `logs/server-YYYYMMDD.log` | Daily logs, kept 14 days                                              |
| `cli-cwd/`                 | Working directory for `orca` and `gh` subprocesses                    |
| `orca-home/`               | Default Orca folder workspace for the shim terminal                   |

Directories are created with mode 0700. Only one backend may use a data
directory at a time.

`orca-home/` is created only while `orca.homeDir` is empty.

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

The budget values themselves are set per stage in the template; see
[Template budgets](#template-budgets).

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

For v0.1 the only change to the built-in `feature-to-pr` template is the
meeting stage's `maxTurns`, raised from 80 to 120 (see below). A copy made
before that keeps 80. A meeting that runs long may then open a budget exception
gate. Either take the new built-in as described above, or change that one value
in your copy:

```yaml
budget: { tokens: 300000, maxTurns: 120 } # stages[id=meeting]
```

### Template budgets

Each stage has a token budget and, except the implement stage, a turn budget.
The implement stage also has a per-item budget (per attempt) and the workflow
has an overall token budget. Crossing a budget opens an exception gate.
Reaching `hardLimitMultiplier` (2) times the budget stops the agents. With
`budget.enforcement = "off"` nothing is enforced.

The built-in values were calibrated on a real-scale run: production mode, real
Orca, GitHub, Claude Code and Codex, a five-item feature, 92 minutes end to end.
That run used **522,513 tokens and 220 turns** in total.

| Level               | Budget (tokens / turns) | Measured in the run | Headroom (tokens / turns) |
| ------------------- | ----------------------- | ------------------- | ------------------------- |
| meeting             | 300,000 / **120**       | 173,594 / 76        | 1.73× / 1.58×             |
| breakdown           | 200,000 / 40            | 31,921 / 5          | 6.27× / 8.00×             |
| implement (stage)   | 1,800,000 / –           | 280,282 / –         | 6.42× / –                 |
| implement, per item | 400,000 / 120           | p90 41,235 / p90 23 | 9.70× / 5.22×             |
| integrate           | 200,000 / 60            | 36,716 / 8          | 5.45× / 7.50×             |
| workflow            | 3,000,000 / –           | 522,513 / –         | 5.74× / –                 |

The meeting stage was the only tight one: it used 76 of the earlier 80 turns,
so `maxTurns` went up to 120. Every other value stayed at its earlier default,
with 1.6× to 9.7× headroom. Implement-stage usage includes the merge queue and
the on-call lead. Tokens count `usage.budgetFormula` (cache reads excluded by
default).

#### Recalibrating

Values only ever go up. For stage, per-item and turn budgets:

```text
new = max(old, roundUp(p90 × 1.5), roundUp(largest run × 1.1))
```

The workflow budget is `max(old, roundUp(largest run × 1.5))`. Tokens round up
to 50,000 and turns to 10. The implement stage's budget is the per-item share's
p90 × 1.5 × `maxParallel` × 2. A per-item share is an item's own usage plus an
equal part of the stage's merge-queue and on-call usage.

`pnpm budget:calibrate` applies this rule to exported workflow events and
checks three things:

- replaying each run with the new values raises no budget events;
- the workflow budget is at least 1.5× every run;
- each threshold alerts exactly once, then its hard limit once.

```sh
pnpm budget:calibrate --events <export.json> [--events <export.json> …] [--baseline <template.yaml>] [--json]
```

`--baseline` defaults to the built-in template. Each `--events` file counts as
one accepted run. v0.1 has no export button: the masked event exports come
from the maintainer's live joint-run harness
(`apps/server/src/test-support/joint/`). The tool only proposes values; copy
them into your template by hand.
