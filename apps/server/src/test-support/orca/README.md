# Real Orca test support (M2)

T0 supplies only the env-flag gate and test-selection guards. M2-T8 extends this
folder with the harness, test-repository origin safety gate, recording/replay,
resource ledger, cleanup and interactive two-phase restart verification.

## Test selection and opt-in

- Ordinary tests and sanitized replay tests use `*.test.ts` and run in CI.
- Live tests use `*.orca.test.ts`, selected only by `@ai-office/server-orca`.
  `pnpm test` and `pnpm test:coverage` exclude this project; the default server
  project also excludes these files.
- Wrap every live suite in `realOrcaSuite(name, { agents?, disruptive? }, fn)`.
  Missing `AIO_REAL_ORCA=1`, or missing `AIO_REAL_AGENTS=1` for agent suites,
  registers `describe.skip` and prints the reason. Any nonempty `CI` always skips.
  Keep IO in hooks/test bodies: skipped describe callbacks still collect tests.
- `pnpm test:orca` opts into CLI-only suites and explicitly disables agent suites,
  even if the parent environment has agent opt-in enabled.
  `pnpm test:orca:agents` opts into both. Neither flag authorizes a worker to run
  these commands: the coordinator/integrator runs live validation under M2 §1.4.
- `test:orca:disruptive`, `orca:record`, `orca:recheck`, and `orca:janitor` fail with
  `not available until M2-T8`. Disruptive suites also remain skipped. T8 must add
  interactive authorization and persisted prepare/verify phases; an environment
  variable never constitutes permission to restart Orca.

The flag gate is not the full safety harness. Before live tests are introduced,
T8 must validate `AIO_TEST_REPO_PATH` and the exact configured test-repo origin,
and restrict mutations to resources in its ledger. No unfiltered inbox, resets,
settings changes, upgrades or autonomous restarts are permitted.

## Dependency placement

Only this test-support subtree gains permission to import `node:child_process`;
use `spawn` without adding execa. Acceptance tests in `acceptance/orca/` call these
helpers instead of importing process APIs. Production cannot import test-support.
The git-only SCM substitute must implement ports directly and must not import any
adapter (including scm-fake); its in-memory model is independently implemented.

## Test-only SCM injection contract (implementation: M2-T10)

Add the following programmatic option to `startServer`:

```ts
testOnly?: { scm?: ScmPort };
```

Accept the option only when both `--dev` and `--runtime orca` are selected.
Providing `testOnly` in any other mode (including an empty object, fake runtime,
or non-dev Orca runtime) must throw `StartupError` before startup side effects.
In the allowed mode, `testOnly.scm` replaces the normally composed scm-fake;
omitting `scm` retains normal composition. The injected instance must serve all
SCM consumers, including observations and merge processing.

CLI arguments, `parseArgs`, config files and environment variables must not expose
this option. Production must never import or construct `scm-gitremote`; tests
construct it and pass it through the `ScmPort` interface. This adds no public
contracts schema or §8.4 registry name. T0 does not implement the injection.

T10 tests must reject fake/non-dev injection, prove the supplied instance is used
in dev/Orca mode, and verify unchanged composition when the option is absent.
T17a implements the git-only substitute here; T17 uses it for engine-driven E2E.
