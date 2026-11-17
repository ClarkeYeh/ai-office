# Fake runtime

`createFakeRuntime({ clock, scenario, submitter, onPush, localRepos, readSpec,
remoteHead, submitRetryMs })` implements `RuntimePort` without processes, files,
logging, or imports from other adapters. Cross-fake behavior is injected as
callbacks, so a composition root wires each with one line.

Use `mainlineScenario` from `./mainline.js` for the progressive-merge §0.1
agent behavior, answering the engine's actual turns:

- The facilitator submits the agenda at spawn. It submits a statement for the
  round named in a round message (JSON `{ round }`, or a prose reminder
  "round N"), and the conclusion when the message asks for one.
- Participants only report done at spawn, then speak for the requested round.
- Planning proposes a feature and a dependent item. Workers push and finish.
- The `merge-queue` role (spawned `keepOpen: true`) reads the engine's review
  body `{ pr, headSha, ... }` and submits `merge-request` with
  `expectedHeadSha: headSha`. `rework: true` (test stimulus) submits a
  rework request instead.
- `integrator` submits the final integration report.

Roles come from the spec the agent read (`# AI Office spec: <purpose>`) when
`readSpec` is injected, else from the spawn title. Sample SHAs and report PR
numbers in `mainline-actions.ts` are illustrative. The application still drives
human gates, dispatch, readiness and meeting rounds.

A scenario maps spawn titles to roles by default. Supply `scenario.role(request,
spec?)` to select a role from the prompt or spec. Each role has `spawn`, `send`
and `answer` scripts, either arrays or context functions. `afterMs` is measured
from that trigger; equal timestamps retain array order. Context includes the
spawn request, the spec text (when read), workspace, agent, turn (starting at
1), and the incoming message. Use distinct command IDs for distinct turns.
`ignoreStop` models a live worker that refuses to end at a gate.

## Injected agent and Git behavior

- `readSpec(path, sha256)`: how an agent reads the spec named in its prompt
  (`Read the AI Office spec at <path> (sha256 <hex>)`). The seat token is taken
  from the prompt or the spec text. Without it, only the prompt is searched.
- `remoteHead(ref)`: what `git fetch` sees. Before `prepareWorkspace` with a
  `fetchBranch`, the fake mirrors that branch's head and a pinned base commit
  (if the remote has it) into its remote model. This is the same model that
  `setRemoteBranch` controls in tests.
- `onPush({ branch, base, ... })`: a push targets the branch the agent's
  workspace was prepared with, carrying the base commit for a new remote
  branch. The scenario's branch is used only for workspaces the fake did not
  prepare.
- `submitRetryMs`: a submitter failure with a transient `PortError` (backend
  down or restarting) reschedules the same submission after this delay, like
  `ai-office submit` exiting 2 and the agent retrying. Without it, failures are
  consumed (see below).

Advance the injected `Clock` and await `runtime.runDue()`; `observe()` also pumps
before creating a new delivery, and `send()` pumps before starting a follow-up
so an expired terminal cannot be revived. There are no real timers. Consume each returned
cursor for the next batch, including empty batches. Retrying an old cursor
replays its original batch exactly, with the same external keys and timestamp.
`enqueue(agent, ...steps)` injects external stimuli through the same scheduler.
A new send cancels remaining actions from the previous turn, including its
pending auto-release. Stop/release/lost cancel pending actions. Done leaves the
terminal alive; without keepOpen it releases 120 seconds after the done time.
`activeAgents()` includes done workers whose terminals are still alive.

The injected submitter receives the typed submission, terminal handle, pane key,
and the single unique `aio_seat_...` token parsed from the spawn prompt. It can
call an application use case or POST to the agent gateway. No credential is
copied to runtime events. Submission and push callbacks are awaited, and their
errors propagate from the pump; failed steps are consumed (no silent automatic
retry) unless `submitRetryMs` is set for transient submit failures. Push simulation
requires `onPush`, so a composition root can update an SCM fake without adapter
imports. Neither callback makes a network request unless the caller supplies one.

`injectFault(operation, 'disconnect')` fails before side effects once;
`setConnected(false)` keeps port operations unavailable until restored.
`injectFault(operation, 'response-lost')` fails after mutation/delivery, allowing
command or cursor replay to recover. Correlated calls compare all request fields
independent of object key order; a command ID reused with changed arguments is
`PortError('bug', 'request_mismatch', ...)`. This state is in memory: a test can
replace its application while retaining this runtime to model a backend crash;
it does not model destruction of the external Orca runtime itself.

The portable `test-support/runtime-port-contract.ts` suite accepts a runtime,
spawn request, clock advancement, caller identity, and stimulus hooks. M2 can
bind those hooks to Orca fixture replay; assertions do not inspect fake state.

## Workspace bases

`prepareWorkspace` returns `{ workspace, path, baseSha? }`; the opaque ref is
not a filesystem path. For implement dispatch, the application first resolves
`ScmPort.compareBranch(repo, integration, integration).headSha`, then records
that SHA as `baseBranch` and supplies `fetchBranch: integration`. The optional
port input `baseSha`, when supplied, must match `baseBranch`. The current
contracts command input carries only `baseBranch` and `fetchBranch`; the
returned `baseSha` is available for `workitem.dispatched` (T14/T23).

Wire `setRemoteBranch(repo, branch, headSha)` to the test's SCM head after a
merge. This models monotonically advancing remote history without coupling
adapters. `fetchedBranches()` records fetches; preparation fetches before
checking that the pinned SHA is available, and never silently substitutes a
newer remote head. Same-command replay returns the original path/ref/SHA and
does not fetch or create again, including after a lost response. Unknown remote
branches or unavailable commits fail with a guard error. Requests without fetch
or SHA retain legacy meeting-workspace behavior. This simulator has no local
Git repository and does not verify Orca's real SHA-base support; P7 remains M2.

Existing-branch rework uses prepareWorkspace with checkoutExisting: true,
fetchBranch equal to branch, and baseBranch pinned to the worker branch head
returned by scm.compareBranch. The caller supplies a fresh deterministic name
ending in -r<n> and a new command ID; the branch itself remains unchanged.
The fake validates and fetches that branch, returns the pinned baseSha, and
replays a lost response without fetching or creating a second workspace.
Real Orca checkout behavior remains M2 verification P8.
