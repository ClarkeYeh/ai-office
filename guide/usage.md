# Usage

The examples assume the `ai-office` alias from [Install](install.md#the-ai-office-command).

## Start and stop

```sh
ai-office start [--port <n>] [--no-open] [--break-lock]
```

`start` launches the backend as a child process and waits until it is ready.
Production startup checks Orca, the shim terminal and your GitHub identity, and
finishes recovery from the previous run. Then `start` prints

```text
AI Office listening on http://127.0.0.1:4319 (runtime: orca, scm: github <owner>)
Open http://127.0.0.1:4319/auth/bootstrap?code=<one-time-code>
```

and opens the second line's link in your browser. The UI then lives at
`http://127.0.0.1:4319` (or the port from `server.port` / `--port`). Use
`127.0.0.1` rather than `localhost`, so the session cookie is set for the same
address.

| Flag           | Effect                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--port <n>`   | Listen on another port for this run (`0` picks a free one). Default: `server.port`, `4319`.                                                      |
| `--no-open`    | Do not open a browser; use the printed link yourself.                                                                                            |
| `--break-lock` | Remove a stale instance lock first. Only use it when no backend is running ([Troubleshooting](troubleshooting.md#ai-office-is-already-running)). |

`start` stays attached to the backend. **Press Ctrl-C to stop**: the backend
drains in-flight work, records what is still pending, removes `runtime.json`
and releases the lock. Agents that are running keep running in Orca. After the
next `start`, the backend reconciles and picks them up again
([Troubleshooting](troubleshooting.md#after-a-backend-restart)).

If startup fails, the backend's reason is printed above
`AI Office backend exited during startup.`; see
[Troubleshooting](troubleshooting.md#startup-refusals).

The backend listens only on `127.0.0.1`. The UI is in Traditional Chinese
(zh-TW).

## Log in again

The login link is one-time and valid for 60 seconds. It sets a session cookie
that lasts 30 days. When the session expires, or you clear cookies or switch
browsers, the UI shows an explanation page instead of data.

```sh
ai-office open [--home <abs-path>] [--no-open] [--print]
```

`open` asks the running backend for a fresh one-time link and opens it, without
restarting anything. It prints the link either way. `--no-open` and `--print`
skip the browser. `--home` selects another data directory; the default is
`AI_OFFICE_HOME`, then `~/.ai-office`. If no running backend can be verified,
`open` tells you to run `ai-office start`.

## Register a repository

Open **Repos** (`http://127.0.0.1:4319/repos`). The page lists two things,
read each time you open it or press **重新整理** (refresh):

- **本機 Repo（來自 Orca）**: the git repositories you have added to Orca
  ([Prerequisites](prerequisites.md#repositories-in-orca)); folder workspaces
  are left out. Press **註冊** (register) on a row. A registered row shows
  **✓ 已註冊**. A row whose `origin` is not a GitHub repository shows the reason
  and cannot be registered.
- **GitHub 上的 Repo**: up to 100 of your own GitHub repositories, most
  recently pushed first; archived ones are dimmed. A repository that is
  already in Orca links to its row above. One that is not shows
  **尚未加入 Orca** and a command to copy: `git clone` it, then add the folder
  in Orca (or `orca repo add --path <dir>`). AI Office only shows these
  commands; it never runs them.

If Orca or GitHub cannot be read, the page says so and still lists the other.
Opening the page may reuse the Orca list for up to 30 seconds; press
**重新整理** to show a repository you have just added to Orca right away.

A repository that is not listed can still be registered: paste the absolute
local path of its main worktree under **不在清單？貼上本機路徑**. Either way the
backend works out the GitHub `owner/name` from `origin` and checks the
repository settings.

Warnings appear on the repository; see
[Prerequisites](prerequisites.md#repository-settings) for what each means. A
repository with merge commits disabled is `repo_not_ready` and cannot start
workflows.

Only registered repositories can be written to.

## Start a workflow

Open **New workflow** (`/workflows/new`):

1. Choose a template and a registered repository.
2. Describe the requirement.
3. Optionally switch off the optional gates (conclusion and task split). The
   final PR gate is always on.
4. Start.

One workflow runs at a time; starting another returns `workflow_slot_busy`.
When Orca is `unverified`, you are asked to confirm once before starting.

The built-in `feature-to-pr` template runs these stages:

1. **Meeting**: the lead runs up to two rounds with the PM, architect and
   engineer, and writes a conclusion with technology decisions. The backend
   posts it as a GitHub issue labelled `ai-office:conclusion`.
2. **Breakdown**: the lead splits the approved conclusion into work items.
3. **Implement**: one agent per work item, each in its own worktree and
   `ai-office/<id>/...` branch, opens a worker PR into the integration branch.
   A merge-queue integrator reviews and merges them one by one. An on-call lead
   answers the implementers' questions.
4. **Integrate**: an integrator verifies the integration branch as a whole,
   fixes forward, writes an integration report, and the backend opens the
   **final PR** into the default branch.

## The three gates

Stage gates open only when **no agent of that workflow is alive**: every agent
must have stopped first.

| Gate       | Your options                                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conclusion | **Approve**, **edit and approve** (written back to the issue), or **reject** with feedback (reruns the meeting; at most 2 reruns). If the issue was edited on GitHub, the UI shows the difference and approval uses the GitHub version.                                                   |
| Task split | **Approve** the list, **edit** items (title, body, acceptance, role, agent, dependencies; add or remove), or **reject** with feedback. Issues for the work items are created only after approval.                                                                                         |
| Final PR   | There is no approve button. **Merge the final PR on GitHub yourself**; AI Office sees the merge and completes the workflow. Or **request changes** with a comment: the integrator reruns in revision mode with your comment and your own review comments on the PR (at most 2 revisions). |

If the final PR is closed on GitHub without merging, the gate stays open and
says so; you can reopen and merge it later, keep it open, or abort the
workflow.

**Exception gates** open when something needs your decision while work
continues: a work item failed, an agent stalled or asked for a decision, a
question was escalated to you, a budget was exceeded, a merge conflict cannot
be resolved, or an anomaly was detected (for example, an agent did something
only the backend may do). Each lists its options, always including abort.

When Orca, GitHub or the database is unhealthy, no gate opens. The workflow is
**paused** with a banner, and resumes by itself when the component recovers.

Comments or labels on GitHub are never treated as decisions. Decisions happen
only in the AI Office UI.

## Watch the office

- **Workflows** (home, `/`): every workflow with its progress, open gates and
  token usage, plus **Cancel** and **Cleanup**.
- **Office** (`/workflows/<id>`): every agent of the workflow at a desk, with
  its current status. Click a seat to inspect it: current item, recent actions
  (metadata only), token usage, errors and attempts. You can also send a
  running agent an extra instruction from there.
- **Board** (`/workflows/<id>/board`): work items and their PRs.
- **Gates** (`/gates/<id>`) and **questions** (`/questions/<id>`): open them
  from the banner or the workflow when a decision is waiting.

The office updates live, but not instantly:

- **Orca state and messages** (an agent starting, stopping, waiting or sending
  a message): the target is within 3 seconds (p95).
- **Activity derived from agent transcripts** (a seat's recent actions and tool
  use): the target is within 15 seconds (p95). The real-scale run measured
  12.5 seconds.

A seat that looks a few seconds behind its Orca terminal is expected.

## Cleanup

Each workflow leaves worktrees in Orca and `ai-office/<id>/...` worker branches
on GitHub.

- **Automatic** (default `retention.workerBranches = "delete-on-complete"`):
  when the workflow completes, the backend removes its worker worktrees and
  worker branches. A worktree with unpushed commits or uncommitted changes is
  not removed; the workflow then shows a `cleanup-failed` warning naming it.
  The workflow stays completed.
- **Manual**: on the workflow list, **Cleanup** is available once a workflow
  is no longer running. It removes the same resources.
  Use it after a cancel, with `keep`, or to retry after `cleanup-failed`.

The integration branch and the default branch are never deleted.

## Cancel

**Cancel** on the workflow list (while it runs) stops every agent of the workflow and ends it as
cancelled. Nothing is merged. Run **Cleanup** afterwards to remove its
worktrees and branches.

## Replay

Open **Timeline** (`/workflows/<id>/timeline`) and start replay. Drag the
scrubber or use the arrow keys to see the office, seats and gates as they were
at any event. Replay is read-only: decisions are disabled until you go back to
live. Replay continues across backend restarts.

## Fake mode

Fake mode simulates Orca, GitHub and the agents. It is for trying the UI and for
development, and only runs with `--dev`. Two ways to run it:

```sh
# Vite dev server with hot reload, in a fresh .dev-home/<scenario>-* directory
pnpm dev:office --fake <scenario> [--open] [--auto-merge-final <seconds>]

# The built UI served by the backend
AI_OFFICE_HOME=~/aio-fake ai-office start --dev --fake mainline --port 0
```

`pnpm dev:office` scenarios: `demo` (default), `mainline`, `parallel`,
`trouble`, `load-10`, `stall`. A simulated repository is registered
automatically; start a workflow as usual. The Repos page also lists a few
simulated Orca and GitHub repositories to try the picker with. `demo` merges the simulated final PR by itself
after 8 seconds; `--auto-merge-final <seconds>` sets that delay (`0` waits for
you). The backend also knows `github-mainline`.

Fake mode refuses to start without `--dev`, so it can never serve your real
data. Always give it its own `AI_OFFICE_HOME`.
