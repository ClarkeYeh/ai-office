# M3-T15 mixed acceptance (fake agents + real GitHub)

One scenario script (`test-support/scenario.ts`) runs M3_PLAN §6 "M3-T15"
steps 1–11 through the composed `--dev --fake github-mainline` server with
`testOnly.scm`. Only the binding differs:

| File                          | Binding                                                             | Where                  |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------- |
| `mainline.acceptance.test.ts` | scm-fake behind the same T7 scoping and push bridge                 | CI (`pnpm test`)       |
| `faults.acceptance.test.ts`   | step 12 on scm-fake (lost create + list lag; breaker open + cancel) | CI                     |
| `mainline.github.test.ts`     | scm-github over the guarded T7 transport, live on the spike         | `pnpm test:github:e2e` |
| `faults.github.test.ts`       | step 12 once, live; faults injected below scm-github                | `pnpm test:github:e2e` |

Live runs need the T7 gate (README in `test-support/github/`): `AIO_REAL_GITHUB=1`,
CI unset, the selected and active account `ClarkeYeh`, quota ≥ 1500 and the
live lock. They are serial, touch only `ClarkeYeh/ai-office-spike`, and never
merge into `main`: step 11 closes and reopens the final PR, and step 13 (the
janitor plus the independent scan) closes it. Each run writes a private report
(steps, created and cleaned objects, rate-limit before/after, call counts) to
`~/.ai-office/test-state/t15-<name>-<runId>.json`.

```sh
AIO_REAL_GITHUB=1 pnpm test:github:e2e                       # verify
AIO_REAL_GITHUB=1 AIO_GITHUB_RECORD=1 pnpm test:github:e2e   # also record
pnpm exec vitest run apps/server/src/acceptance/github/ --maxWorkers=2
pnpm fixtures:scan
```

Recording writes (`wx`, only after a clean run with every step green)
`fixtures/github/2022-11-28/acceptance/t15-mainline.trace.json`, the event
semantics the CI replay asserts, plus the sanitized HTTP recordings
`t15-mainline.http.json` and `t15-faults.http.json` as evidence. A whole
workflow cannot be replayed call by call: the observation loop's timing decides
the HTTP order, and strict `ReplayFetch` matches order. So the CI replay checks
event-sequence semantics (`semantics()`): the stage and gate flow and each work
item's history in order, all golden lines as a multiset. The HTTP tapes are
evidence only (coordinator ruling). Step 12's CI version runs composed on
scm-fake; the adapter-level `ReplayFetch` lost-response case stays the T8 shared
contract case. Since `[M3-FX]` (#157) an injected `testOnly.scm` is polled at
the SPEC §12.2 cadence (15 s, 30 s at the final gate) in CI and live alike, so
the CI twins take about two minutes.

Test-only adaptations, all on the harness side:

- The T7 namespace rewrites markers, so an unedited conclusion's
  `renderedHash` never equals GitHub's body hash; approvals then send the hash
  of the `githubBody` the screen shows.
- The owner's own objects (step 9's unmarked Issue, step 10's `/approve`
  comment) carry `<!-- aio-test:owner=t<runId>:… -->` instead of an AI Office
  marker, so they stay ledgered and cleanable while AI Office sees them as
  unmarked. The scenario asserts both halves: the owner marker is on the
  object and no `ai-office:cmd` marker is, and the product still raises
  `unknown-object` (step 9) and changes no state (step 10).
