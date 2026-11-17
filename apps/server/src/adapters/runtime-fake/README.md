# Fake runtime

`createFakeRuntime({ clock, scenario, submitter, onPush, localRepos })` implements
`RuntimePort` without processes, files, logging, or imports from other adapters.
Use `mainlineScenario` from `./mainline.js` for the progressive-merge §0.1
agent behavior example. Planning proposes a feature and a dependent item. The
`merge-queue` role is spawned with `keepOpen: true`; each send body is JSON
`{ pr, expectedHeadSha, rework?: boolean }`. A rework review submits reasons;
the harness pushes another commit to the same worker branch/PR before sending
it for review again. The same reviewer can merge the dependent PR next.
`integrator` only submits the final integration report. Sample worker branch,
SHA and report PR numbers in `mainline-actions.ts` are illustrative values to
map to the application's SCM fixture. The application still drives human gates,
role dispatch, readiness, and meeting rounds. `progressive-merge.test.ts`
exercises these adapter interactions; the full workflow event golden is T34.

A scenario maps spawn titles to roles by default; supply `scenario.role(request)`
to select a role using the composition root's prompt/title convention. Each role
has `spawn`, `send`, and `answer` scripts, either arrays or context functions.
`afterMs` is measured from that trigger; equal timestamps retain array order.
Context includes the spawn request, workspace, agent, turn (starting at 1), and
incoming message. Use distinct command IDs for distinct turns. `ignoreStop`
models a live worker that refuses to end at a gate.

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
retry). Inject retries explicitly in the scenario when needed. Push simulation
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
