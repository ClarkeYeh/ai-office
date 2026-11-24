# Joint-run harness (M5-T7)

One harness for the M5 real-scale runs, switchable between two modes
(`AIO_JOINT_MODE`):

| Mode         | Used by                                   | Backend                                           | SCM                                                                                      | Final PR                                                      |
| ------------ | ----------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `production` | T12 (`acceptance/joint/m5.joint.test.ts`) | real `ai-office start` (`orca/production-cli.ts`) | real GitHub on the spike (`withHarness`: GitHub live lock, safety gate, ledger, janitor) | the owner merges by hand (W2); the harness writes `can-merge` |
| `preview`    | T11b (`joint/preview/`)                   | `--dev --runtime orca` child (`backend-child.ts`) | scm-gitremote stand-in in the harness process, reached over IPC (`scm-bridge.ts`)        | the stand-in's explicit merge                                 |

Both hold the GitHub and Orca live locks for the whole run, use an isolated
`AI_OFFICE_HOME` with a fixed port (never `~/.ai-office`, never 4319), and run
T8's `m5-mainline` text (`scenario/`).

## Modules

- `restart.ts`: K / K′ trigger (pure, over domain events) and the restart
  control. Exactly one `SIGKILL` per run, only to a pid that the control
  started and that holds `runtime.json`; restart on the same home and port;
  downtime and readiness timing (§2.3.3). Process operations are injected:
  CI tests use fake processes only.
- `owner-policy.ts`: executes T8's §2.2.4 table (`ownerAction`,
  `releaseHeldAnswer`) over an injected port, including holding back the
  code-name answer until the restart is ready or 10 minutes have passed.
  Anything outside the table goes to the private status file. The final-PR
  gate is never decided.
- `assertions.ts`: §2.3.4 restart assertions #1–10 and #12–17 (#11 is T17)
  as pure functions over events plus observations; missing observations make
  a row (or part of it) `n/a`, never a pass.
  #17 is revised by coordinator ruling: instead of counting resends (they
  fail at TCP level while the backend is down), it checks that the merge-request
  in flight at K was accepted exactly once (before the kill), that its merge
  outcome lands after the kill with a single first-parent merge commit, and
  that no submission id is accepted twice.
- `session.ts`: cookie sessions that outlive the restart, and the harness SSE
  client that reconnects with `Last-Event-ID` and records every seq.
- `sampler.ts`: health sampler every 30 s (CLI calls per minute, adapter call
  counts, rate-limit remaining). Numbers only.
- `observe.ts`: live readers for the assertions (lock ownership, runtime
  ingest cursor, the run's inbox, control token, `ai-office open --print`,
  gateway resend counts). Each one fails soft to `n/a`.
- `export-run.ts`: the B4 step. Raw events go only to a private directory
  outside the repo (0700/0600); the masked export comes from T0's
  `export/` (`exportJointEvents`).
- `backends.ts`: launchers for both modes and the isolated home and port.
- `run.ts`: the shared control flow (runner scenario entry).

## Running

Offline CI covers the units (`pnpm exec vitest run
apps/server/src/test-support/joint --maxWorkers=2`). Live runs belong to
T11b and T12 only, after `pnpm -r build`, under `caffeinate -i`:

```sh
AIO_JOINT_STATUS=/abs/private/status.json \
AIO_JOINT_REPORT=/abs/private/report.json \
AIO_JOINT_PRIVATE_DIR=/abs/private/exports \
pnpm test:joint
```

Reports and status files contain ids, counts, booleans and durations only.
