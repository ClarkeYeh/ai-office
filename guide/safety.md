# Safety

AI Office lets AI agents change code in repositories you own and push to
GitHub with your account. This page explains what protects you, what does not,
and what data is kept.

## Who is trusted

- **You** are the only decision maker.
- **Agents** (Claude Code, Codex) are trusted but fallible: not malicious, but
  they make mistakes. They run as your OS user and share your `gh`
  credentials.
- **Other GitHub users** are not trusted. Nothing they write on GitHub
  influences a workflow.
- **The network**: the backend listens only on `127.0.0.1`.

## Decisions happen only in AI Office

- Every gate decision is made in the AI Office UI, which requires your session
  cookie and checks Host and Origin.
- Comments (including `/approve`) and labels on GitHub are never parsed as
  decisions.
- Agents talk to the backend only through `ai-office submit`, which cannot make
  any decision.
- Stage gates (conclusion, task split, final PR) open only after every agent of
  the workflow has stopped. Nobody but you is acting while you decide.
- Before you approve a conclusion that was edited on GitHub, the UI shows the
  difference. If the issue changes again before your approval lands, the
  approval is refused (`gate_content_changed`) and you see the new version.

## What the backend may do on GitHub

The GitHub client enforces two allowlists in code, whatever your token could
do:

- **Endpoints**: only the specific read and write calls AI Office needs. It has
  no call to update refs, force-push, write files, change repository settings
  or rulesets, or delete issues. Anything else fails with
  `endpoint_not_allowed`.
- **Repositories**: only registered repositories can be written. Other
  repositories get only the read-only calls registration needs.

**Merge guard.** The backend merges only into a planned `ai-office/...`
integration branch that is not the default branch and not protected. It names
that branch explicitly in the merge call, so retargeting a PR cannot redirect
the merge. It verifies the PR's head and base before merging and confirms the
merge afterwards. **Only you merge into the default branch**, by merging the
final PR on GitHub.

A ruleset with 0 required approvals does not stop API merges into the default
branch. The merge guard is what keeps the backend out. Protect the default
branch anyway ([Prerequisites](prerequisites.md#repository-settings)).

The backend deletes comments only if it created them itself, and branches only
under the workflow's `ai-office/<id>/` namespace.

## Account policy

The backend reads the owner's token with
`gh auth token --user <owner>`. Agents push with `gh`'s active account. AI
Office refuses to start when the active account is not the owner
(`scm_login_mismatch`), rechecks every five minutes, and pauses workflows on a
mismatch. It never runs `gh auth switch`.

## What agents can do

Agents are instructed to stay within their task, and AI Office watches what they
do. It cannot stop them in advance:

- Codex runs with approvals and sandbox off, so it can run any command on your
  machine.
- Agents can use your `gh` credentials, for example to run `gh pr merge` or
  create issues.
- Agents inherit your full agent configuration, **including your MCP tools**.
  An agent may, for example, read a connected workspace such as Notion.
- Agents can read files you can read, including `~/.ai-office` and browser
  cookies.

## What agents are told not to do, and how it is caught

Each agent's instructions forbid acting outside its role. The backend scans the
tool calls it observes (policy detection) and watches GitHub (anomaly
detection) for:

- merging or creating PRs, editing PRs, or creating issues with `gh`
  (GitHub writes go through the backend only);
- pushing to the default branch, or to the integration branch during
  implementation;
- starting other agents, or taking over the backend's Orca run (`run-use`);
- stopping or releasing workers;
- reading the local control token used by `ai-office open`.

A high-severity hit stops that agent at once and opens an anomaly gate. You
choose "this was me, continue" or abort. Detection happens after the fact.

## Backend identity in Orca

Orca infers who is calling from the environment and the working directory. So
every `orca` subprocess the backend runs:

- gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL` and `TMPDIR`
  (all `ORCA_*`, `CLAUDE*`, `CODEX_*`, `GH_*`, `GITHUB_*`, `AI_OFFICE_*`
  removed);
- runs in `<dataDir>/cli-cwd`, outside every Orca worktree (checked at start and
  before each subprocess);
- passes its identity explicitly, through the shim terminal.

Every 30 seconds the backend checks that it still owns its run. If something
takes it over, dispatch pauses and an anomaly gate asks whether to reclaim it.

## Residual risks (accepted for v0.1)

1. While a stage runs, an agent could merge the final PR, change labels or
   create issues with the shared credentials. Instructions forbid it;
   detection reports it afterwards.
2. During the final PR gate, a merge on GitHub cannot be told apart from yours
   (same login). No agent is alive then.
3. During exception gates agents may still be running. They still cannot
   decide anything.
4. Agents run as you. They could read the data directory, browser cookies, a
   printed login link or the control token, and call the AI Office API. Local
   processes with your permissions are outside v0.1's protection.
5. An agent's submission token appears in its transcript and process
   arguments. It is limited to that one attempt and needs the matching terminal
   handle. The database stores only its hash.
6. Orca updates itself and may change behavior mid-run. AI Office re-reads the
   version, validates every response and marks the runtime `unverified`.
7. Any local process, an agent included, can stop Orca workers or take over a
   run. AI Office detects and pauses; it cannot prevent it.
8. Agents started outside Orca orchestration are invisible to the backend
   except through policy detection.
9. A filtering Codex `shell_environment_policy` weakens submission identity
   checks ([Prerequisites](prerequisites.md#codex-shell_environment_policy)).
10. Usage comes from undocumented local session-log formats. If they change,
    usage becomes unavailable and budgets fall back to substitute limits.
11. If a crashed backend's pid is reused, the next start may wrongly see the
    lock as held. Check, then use `--break-lock`.
12. Logging out, restarting the Mac, or a crash of Orca's terminal host kills
    the shim and all agents. Restarting the Orca app alone does not.
13. Agents inherit your MCP tools (see above).

## Data kept and masking

- **Agent transcripts are never stored.** Tool inputs and outputs, file
  contents, command output and free text stay out of the database and logs.
  Only metadata is kept: tool name, category, success, duration, length, hash.
- **Structured submissions** (agendas, statements, conclusions, work items,
  answers, merge requests, reports, decision requests) and worker questions are
  kept, after masking emails, GitHub/OpenAI/Anthropic tokens, private keys,
  AI Office tokens and high-entropy strings.
- **GitHub content** is stored as references (numbers, URLs, body hashes),
  except the approved conclusion's body, kept as the approval record.
- **Secrets**: the GitHub token lives only in memory. Session, login-code and
  submission secrets are stored only as hashes. Per-attempt instruction files
  are mode 0600 and deleted when the attempt ends.
- **Logs** rotate daily and are kept for 14 days.
- Everything stays in your data directory. Nothing is sent anywhere except to
  GitHub and Orca as part of the workflow.

The issue and PR bodies AI Office writes on GitHub include text from agents.
On a public repository, keep requirements free of anything private.
