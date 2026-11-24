# Dogfooding: AI Office develops AI Office

> **Status: draft.** Spots marked `TODO(T12)` are filled in after the M5 joint
> run. Nothing in this runbook happens before v0.1 ships.

"Dogfooding" means that milestones after v0.1 are run as AI Office workflows on
this repository: worker PRs flow into an `ai-office/...` integration branch,
AI Office opens the final PR, and the owner decides at the gates and merges the
final PR on GitHub. Manual dispatch through Orca orchestration stays available
as the fallback.

## Who does what

| Step                                                            | Who                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare the repository (CI trigger, this runbook, the template) | Ordinary development PR, done during M5                                                                                                           |
| Confirm repository settings                                     | Read-only checks (below); settings are never changed                                                                                              |
| Install the fixed v0.1.0 build that runs AI Office              | Owner                                                                                                                                             |
| Copy the template into the data directory                       | Owner                                                                                                                                             |
| Register `ClarkeYeh/ai-office` in AI Office                     | **Owner only.** This is the first time AI Office writes to a repository other than the test repository, so only the owner decides and performs it |
| Run the pilot and the retrospective                             | Owner, after v0.1                                                                                                                                 |

AI Office automation never merges into `main`. The final PR is always merged by
a person.

## Switch criteria

All of these must hold before dogfooding becomes the default way of working:

1. **v0.1 is done.** Every v0.1 exit criterion holds and the M5 final PR is
   merged into `main`.
2. **The repository is ready** (see [Repository readiness](#repository-readiness)).
3. **The project template is installed** (see
   [Project template](#project-template-ai-office-devyaml)).
4. **Self-modification is isolated** (see
   [Self-modification isolation](#self-modification-isolation)).
5. **The owner has registered `ClarkeYeh/ai-office`** in their own AI Office
   data directory.
6. **The pilot passed** (see [Pilot](#pilot)), followed by a retrospective.

Criteria 2–4 are prepared in M5; the owner copies the template and installs the
fixed build after v0.1. Criteria 5 and 6 are the first work after v0.1 and start
only when the owner explicitly decides to register the repository.

## Repository readiness

### CI on worker PRs

Worker PRs target an `ai-office/<shortId>-<slug>` integration branch. CI runs
on pull requests into those branches:

```yaml
on:
  pull_request:
    branches: ['integration/**', main, 'ai-office/**']
  push:
    branches: ['integration/**', main]
```

Only `pull_request.branches` includes `'ai-office/**'`. The `push` trigger is
unchanged on purpose: adding `ai-office/**` there would run CI twice for every
integration-branch update. `scripts/ci/workflow.test.mjs` (run by
`pnpm test:scripts`) asserts both.

With checks present on worker PRs, the template's `ci-failed-twice`
escalation takes effect.

### Settings to confirm (read-only)

AI Office re-checks these on registration and on every production start. Before
registering, confirm them by hand with GET requests only:

```sh
gh api repos/ClarkeYeh/ai-office --jq '{allow_merge_commit, default_branch}'
gh api repos/ClarkeYeh/ai-office/rulesets --jq '.[] | {id, name, target, enforcement}'
gh api repos/ClarkeYeh/ai-office/rules/branches/main
gh api repos/ClarkeYeh/ai-office/rules/branches/ai-office/example
```

| Check                  | Required                                                                                                                                | Observed during M5 prep                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow_merge_commit`   | `true` (AI Office merges with the `merge` method; `false` blocks starting a workflow)                                                   | `true`                                                                                                                                               |
| `main` ruleset         | Must not require approvals, or the owner must be able to bypass; otherwise the owner cannot merge their own final PR                    | One active ruleset on `refs/heads/main`: pull request required with 0 approvals, merge methods `merge`/`squash`/`rebase`, no force push, no deletion |
| Rules on `ai-office/*` | None (required reviews, required checks, or a merge-method rule without `merge` would block backend merges into the integration branch) | No rules apply                                                                                                                                       |

Do not change rulesets or repository settings as part of dogfooding. If a check
fails, stop and decide on it separately.

Note: a ruleset with 0 required approvals does not stop an API merge into
`main`. The barrier is AI Office's own merge guard, which never merges into the
default branch.

## Project template: `ai-office-dev.yaml`

The template carries this repository's development rules into every role's
scope. The owner copies it to `<dataDir>/templates/ai-office-dev.yaml` (the file
name must equal the `id`). `<dataDir>` is the data directory of the fixed
installation described below. AI Office validates templates on every read and
lists any validation errors in the UI.

The stage layout and budgets follow the built-in `feature-to-pr` template.
`TODO(T12)`: replace the budgets with the values recalibrated from the M5 joint
run, and adjust the role scopes for any rule changes it surfaces.

```yaml
apiVersion: ai-office/v1alpha1
id: ai-office-dev
name: AI Office development
roles:
  lead:
    agent: claude-code
    effort: high
    scope: >-
      Facilitate the meeting and converge on a conclusion. Split the approved
      conclusion into independently verifiable work items, each naming the
      directories it may change and keeping the dependency direction (apps and
      adapters depend on packages, never the reverse; no new dependency-cruiser
      exceptions). While on call, answer implementers' technical questions.
  pm:
    agent: claude-code
    scope: >-
      Clarify the requirement, user scenarios and acceptance criteria. Point out
      scope risks. Public documentation goes in README.md and guide/; never
      add or link a docs/ directory.
  architect:
    agent: claude-code
    scope: >-
      Propose architecture and technology options with trade-offs. Check
      layering and dependencies against pnpm depcruise. Contract changes in
      packages/contracts are additive only and must keep pnpm contracts:check
      green.
  engineer:
    agent: codex
    scope: >-
      Implement the assigned work item with tests, changing only the directories
      it names. In an Orca worktree run
      export PATH="$HOME/Library/pnpm/.tools/pnpm/10.34.9/bin:$PATH" first.
      Run focused tests with pnpm exec vitest run <path> --maxWorkers=2 and the
      suite with pnpm test --maxWorkers=2 (never put -- before --maxWorkers;
      vitest ignores it). Never run live suites (test:orca*, test:github*,
      test:joint) and never call real Orca or GitHub from tests. Never write
      tokens, emails or transcript text into events, logs, fixtures or PRs.
  integrator:
    agent: claude-code
    scope: >-
      Review worker PRs in the merge queue: scope, dependency direction, tests,
      no secrets. Resolve conflicts or request rework. At wrap-up run the full
      definition of done: pnpm install --frozen-lockfile; pnpm typecheck;
      pnpm typecheck:tests; pnpm -r build; pnpm lint; pnpm test --maxWorkers=2;
      pnpm test:scripts; pnpm test:coverage --maxWorkers=2; pnpm depcruise;
      pnpm depcruise:selftest; pnpm contracts:check; pnpm check:bundle;
      pnpm fixtures:scan; pnpm docs:check. Never run live suites; fix forward
      and write the integration report.
defaults:
  integrationBranch: 'ai-office/{shortId}-{slug}'
  maxReruns: 2
  budget: { hardLimitMultiplier: 2 }
  workflowBudget: { tokens: 3000000 } # TODO(T12): recalibrated value
stages:
  - id: meeting
    kind: meeting
    facilitator: lead
    participants: [pm, architect, engineer]
    maxRounds: 2
    timeouts: { roundMin: 15, stageMin: 60 }
    budget: { tokens: 300000, maxTurns: 80 } # TODO(T12)
    conclusion: { requireTechDecisions: true }
    gate: { id: conclusion, title: Conclusion, optional: true }
  - id: breakdown
    kind: planning
    owner: lead
    from: meeting
    timeouts: { stageMin: 30 }
    budget: { tokens: 200000, maxTurns: 40 } # TODO(T12)
    gate:
      {
        id: task-split,
        title: Task split,
        optional: true,
        editable: [title, body, acceptance, role, agent, deps],
      }
  - id: implement
    kind: implement
    role: engineer
    from: breakdown
    maxParallel: 3
    timeouts: { itemMin: 45 }
    budget: { tokens: 1800000, perItem: { tokens: 400000, maxTurns: 120 } } # TODO(T12)
    onCall: { role: lead, questionTimeoutMin: 10 }
    mergeQueue: { role: integrator, reviewTimeoutMin: 20, maxRework: 2 }
    escalateOn: [unresolvable-conflict, ci-failed-twice]
  - id: integrate
    kind: integrate
    owner: integrator
    timeouts: { stageMin: 30 } # TODO(T12): the full DoD may need more time
    budget: { tokens: 200000, maxTurns: 60 } # TODO(T12)
  - id: final-pr
    kind: final-pr
    maxRevisions: 2
    gate: { id: final-pr, title: Final PR }
```

### Live suites stay manual

AI Office workers never run live suites (`test:orca`, `test:orca:agents`,
`test:orca:disruptive`, `test:github*`, `test:joint`). Those touch real Orca and
the real test repository, require explicit opt-in flags, and run serially under
live locks. The owner or the coordinating agent runs them by hand when a change
needs live evidence.

## Self-modification isolation

AI Office must not run from the worktree it is modifying. Run it from a fixed
installation instead:

1. Make a separate checkout of the `v0.1.0` tag, outside any Orca worktree and
   outside the repository you register:

   ```sh
   git clone --branch v0.1.0 https://github.com/ClarkeYeh/ai-office ~/ai-office-v0.1.0
   cd ~/ai-office-v0.1.0
   pnpm install --frozen-lockfile && pnpm -r build
   ```

2. Start AI Office from that checkout (`ai-office --version` must report
   `0.1.0`). `TODO(T12)`: confirm the exact start command and flags once the
   production restart drill has settled them.
3. Register the working clone of `ClarkeYeh/ai-office` (not the v0.1.0 checkout)
   as the repository AI Office develops.
4. Upgrading the running AI Office to a newer version is an explicit owner
   action: stop it, check out and build the new tag, start it again. Workflows
   never update their own runner.

## Pilot

Dogfooding is declared only after one small, real backlog item runs the whole
flow end to end, up to the owner merging the final PR.

- Suggested item: make the `poll_failing` health flag per repository instead of
  global (deferred from M5).
- Use the `ai-office-dev` template. Keep the conclusion gate and the task-split
  gate on for the pilot.
- During the pilot, watch for: CI results on worker PRs, the integrator running
  the full DoD, no worker attempting a live suite, no writes outside the
  workflow's `ai-office/` namespace, and the final PR waiting for the owner.
- Afterwards, hold a short retrospective: what blocked, which scopes or budgets
  need adjusting, and whether to switch. Record the decision before the next
  milestone starts.

`TODO(T12)`: add the expected durations and usage per stage from the joint run,
and any operational notes (restart behavior, known variance) the pilot should
watch for.

## Fallback

If a workflow stalls or the pilot fails, finish the work with manual Orca
orchestration dispatch on the same integration branch, then fix AI Office
itself in a separate change. The fallback never requires changing repository
settings.
