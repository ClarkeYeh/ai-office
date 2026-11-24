# Prerequisites

Production mode drives real tools with your own accounts. Fake mode needs none
of this.

## Orca

AI Office starts and supervises agents through Orca's orchestration CLI.

- **Supported versions: `>=1.4.259 <1.5`** (`orca.supportedRange`). Versions
  1.4.259, 1.4.263 and 1.4.272 have been checked against recorded contracts.
- **Below the range**, the backend refuses to start.
- **Above the range**, it starts, marks the runtime `unverified`, shows a
  banner, and asks you to confirm once before each new workflow. Running
  workflows continue.
- **Orca updates itself.** The version can change while a workflow runs. AI
  Office re-reads it every five minutes and on each health probe, and switches
  to `unverified` when it changes. Only output that no longer matches the
  expected shape (`runtime_contract_mismatch`) pauses dispatch.
- The Orca app must be running. AI Office finds the `orca` binary on `PATH` or
  inside the Orca app bundle in `/Applications`; set `orca.bin` to an
  absolute path otherwise ([Configuration](configuration.md#orca)).

### The orca-home folder

The backend keeps one hidden "shim" terminal in Orca titled
`AI Office · 請勿關閉` ("do not close"). Orca needs it as the backend's
identity for every orchestration command. The shim lives in a dedicated
**folder workspace**, by default `<dataDir>/orca-home` (`~/.ai-office/orca-home`).

Adding that folder to Orca is a one-time step **you do yourself**. AI Office
never registers folders or repositories in Orca. Create the directory and add
it as a folder:

```sh
mkdir -p ~/.ai-office/orca-home
orca repo add --path ~/.ai-office/orca-home --kind folder
```

Or add the folder from the Orca app. It shows up in Orca as `orca-home`.
A registered folder can later be hidden in Orca, but not deleted. If you use a
different data directory or set `orca.homeDir`, register that path instead.

Never register the data directory itself as an Orca project. The backend runs
`orca` from `<dataDir>/cli-cwd`, which must stay outside every Orca worktree
([Safety](safety.md#backend-identity-in-orca)).

### Repositories in Orca

Every repository you want to use must be a normal git clone (its main
worktree) that **you have added to Orca**. Registration in AI Office fails with
a hint when Orca does not know the repository.

## Agents

Install and sign in to the agent CLIs you want to use. Orca launches them; AI
Office never handles their credentials.

- **Claude Code**: the built-in template uses it for the lead, PM, architect
  and integrator roles.
- **Codex**: the built-in template uses it for the engineer role. Codex runs
  without approvals or sandbox ([Safety](safety.md#what-agents-can-do)).

### Codex `shell_environment_policy`

Agents prove who they are to AI Office partly through Orca's `ORCA_*`
environment variables. A restrictive `shell_environment_policy` in
`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) can strip them. Health
then warns `codex_env_filtered`, and Codex submissions fall back to a weaker,
token-only check. Any of these triggers the warning:

- `inherit` set to anything other than `"all"`
- a non-empty `exclude`
- any `include_only`
- `ignore_default_excludes = false` (the default `*KEY*` exclusion then removes
  `ORCA_PANE_KEY`)

No `shell_environment_policy` at all is fine.

## GitHub CLI and account

AI Office talks to GitHub with your own account. It reads a token from `gh` at
startup and keeps it only in memory.

1. Install `gh` and log in: `gh auth login`.
2. **The active `gh` account must be the account that owns your registered
   repositories.** Agents push with `gh`'s _active_ account (through
   `gh auth git-credential`), while the backend asks for the owner's token
   explicitly. If the two differ, production refuses to start with
   `scm_login_mismatch`. While running, a mismatch pauses workflows
   (`paused{auth}`), checked every five minutes. Fix it with
   `gh auth switch -u <owner>`; AI Office never switches accounts for you.
3. Set `github.expectedLogin` to that login to pin it
   ([Configuration](configuration.md#github)). Without it, health warns
   `expected_login_unset`.

If you keep several accounts, you can give AI Office a separate `gh`
configuration that is logged in only as the owner, through `GH_CONFIG_DIR` (in
the default `env.passthrough`).

### Keep your email private

Merge commits the backend creates through the GitHub API carry your account's
primary email unless GitHub's **"Keep my email addresses private"** setting is
on. Turn it on (GitHub → Settings → Emails) before a first run on a public
repository. Agent commits use the repository's git config: set a repo-local
`user.email` to your GitHub noreply address.

## Repository settings

AI Office merges worker PRs into an `ai-office/...` integration branch through
the API, and you merge the final PR into the default branch on GitHub.

- **Merge commits must be allowed** (`allow_merge_commit`). Otherwise the
  repository is `repo_not_ready` and workflows cannot start.
- **Protect the default branch** with a ruleset (require a pull request).
  Either require 0 approvals or allow yourself to bypass: you cannot approve
  your own final PR, and health warns `default_requires_approvals`.
- **Do not put rules on `ai-office/*`.** Required reviews, required checks, or
  merge methods without `merge` on those branches block the backend's merges
  (`ai_office_branches_ruled`).
- You need push permission, and the repository must not be archived.

AI Office checks these when you register a repository and again on every
production start.

<!-- TODO(M5 final): add anything the real-scale run (M5-T12) shows is missing. -->
