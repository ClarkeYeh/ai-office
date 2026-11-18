# Web fake fixtures

Templates correspond to `demo`, `parallel`, `trouble`, `load-10`, and `stall`.
Use `pnpm dev:office --fake <name>` and choose the matching template when
starting a workflow. Each invocation creates its own ignored `.dev-home` and
uses random backend/frontend ports.

The default scenario is `demo`. Its launcher calls the authenticated
`POST /dev/fake/scm/merge-final-pr` eight seconds after a final gate appears.
`--auto-merge-final 0` disables this; another nonnegative number changes the
launcher delay. This is not a server CLI flag. The launcher issues a separate
session in its own isolated home, leaving the browser bootstrap code untouched.
Other scenarios default to no automatic final merge.

`parallel` proposes four independent items and one dependent item, with six
available worker slots. `load-10` has nine workers plus an on-call agent and
75 seconds of activity. `trouble` includes degraded/lost, policy, escalation,
and repeated rework stimuli. Policy exceptions pause the workflow; resolve
those gates before expecting later stimuli to progress. Set a queued PR's
mergeability to false to exercise the merge-blocked path.

Dev controls are available only when both dev and fake mode are active:

- `POST /dev/fake/scm/merge-final-pr`: `{number}` (unchanged M2 control).
- `POST /dev/fake/scm/edit-issue-body`: `{number, body}`.
- `POST /dev/fake/scm/pr-status`: `{number, mergeable?, checks?}`; checks are
  `none`, `pending`, `success`, or `failure`.
- `POST /dev/fake/runtime/connected`: `{connected}`.

All require the same Host, Origin and session checks as REST. Worker PR merges
remain backend-owned. Hijack control awaits M2's stimulus. `stall` intentionally
sends no worker actions; the spawn-stall exception requires M2 convergence.

See the recorder README under `scripts/record-web-fixtures` for regeneration,
normalization and semantic verification. Rendered animation evidence depends on
the scene/app tasks; this branch supplies the server events and controls.
