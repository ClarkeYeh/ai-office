# Joint-run UI evidence (M5-T17)

`ui-evidence.spec.ts` is a read-only Playwright pass over an **existing**
backend after the joint run (M5_PLAN §5 T17; restart assertion #11, and the
browser half of #15). It starts no process, sends no POST and decides nothing;
the only side effect is the session that the `ai-office open` login URL
creates. Without its environment it is skipped, so `pnpm test:e2e` and CI only
report it as skipped.

| Variable                      | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| `AIO_T17_BACKEND_URL`         | the backend origin, `http://127.0.0.1:<port>` (never 4319)         |
| `AIO_T17_LOGIN_URL`           | `ai-office open --home <home> --print` for that backend            |
| `AIO_T17_RESTART_SEQ`         | the K / K′ trigger seq: `restart.triggerSeq` in the private report |
| `AIO_T17_WORKFLOW_ID`         | optional; needed only when the home holds more than one workflow   |
| `AIO_T17_ALLOW_ZERO_TOKENS=1` | fake backends only: the fake world reports no usage                |

It checks:

- every seat is drawn at its first spawn, and the live office shows every
  agent that worked past the meeting (the scene hides meeting chairs once
  their occupant has left);
- the timeline has one point per workflow event, in order, exact around the
  restart; no seat leaves the office across the restart;
- at every `waiting_input` seq that seat is drawn waiting (`data-state`,
  `data-pose`); the last frame equals the live office (M4's replay = live);
- token usage equals the read model's total (and is above zero live) and
  "預算：停用" is shown;
- the board and every gate page open.

Traces and screenshots are off for this file: they would keep agent text
from the live run on disk.

## Live (inside the T12 window, after W2, before the backend stops)

```sh
pnpm -r build   # only if the build is not frozen; the running backend is untouched
cd apps/e2e
AIO_T17_BACKEND_URL=http://127.0.0.1:<port> \
AIO_T17_LOGIN_URL="$(node ../cli/dist/main.js open --home <home> --print)" \
AIO_T17_RESTART_SEQ=<restart.triggerSeq> \
  pnpm exec playwright test --project=e2e tests/joint
```

## Validating the script against T9's fake world

T7's offline dry run (`--dev --fake m5-mainline`, one kill/restart) keeps its
home when `AIO_JOINT_DRY_DIR` is set; restart a backend on that home and run
the spec against it:

```sh
pnpm -r build
DRY=$(mktemp -d)
AIO_JOINT_DRY_DIR=$DRY pnpm exec vitest run \
  apps/server/src/acceptance/joint/dry-run.acceptance.test.ts --maxWorkers=2
HOME_DIR=$(ls -d $DRY/aio-joint-dry-*/home)
AI_OFFICE_HOME=$HOME_DIR node apps/cli/dist/main.js start --dev --fake m5-mainline --no-open &
# port: [server] port in $HOME_DIR/config.toml; restart seq: restart.triggerSeq in report.json
cd apps/e2e
AIO_T17_BACKEND_URL=http://127.0.0.1:<port> \
AIO_T17_LOGIN_URL="$(node ../cli/dist/main.js open --home $HOME_DIR --print)" \
AIO_T17_RESTART_SEQ=<triggerSeq> AIO_T17_ALLOW_ZERO_TOKENS=1 \
  pnpm exec playwright test --project=e2e tests/joint
```

2026-11-24 on `integration/m5@98040ac`: 4/4 passed (655 events, K at seq 344,
two `waiting_input` seats, four gates). A restart seq that is not a workflow
event, and zero tokens without `AIO_T17_ALLOW_ZERO_TOKENS`, both fail.

## CI replay

`apps/web/src/test-support/office/m5-joint.test.ts` folds the masked
`fixtures/web/m5-joint.events.json` with the real projection and checks seat
poses, needs, board, gate headers, usage, and replay = live fold (semantics
only). The fixture is T12's production run (1812 events, the same file as
`fixtures/m5/joint.events.json`), re-masked offline from the private raw
export with `exportJointEvents`, which also pseudonymizes Orca run, dispatch
and message ids and every UUID (consistently, so links survive);
`fixtures:scan` rejects any real one. `M5_JOINT_RESTART_SEQ` is 1012, the
first event after the restart (K at 991). The recording keeps the run's
duplicate `seat.activity` re-emissions. About 5 s locally.

Live run, 2026-11-25 05:14Z, against the T12 production backend (restart seq
1012): 4/4 passed in 3.3 s.

## Scale (§24): `pnpm e2e:fps` on the M5 head

| Date       | Head                     | Frames | Dropped | p95     | Result |
| ---------- | ------------------------ | ------ | ------- | ------- | ------ |
| 2026-11-24 | `integration/m5@98040ac` | 3601   | 0 (0%)  | 16.7 ms | pass   |
