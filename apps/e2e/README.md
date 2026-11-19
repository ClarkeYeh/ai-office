# @ai-office/e2e

Playwright (Chromium) tests against the **built** AI Office. Every spec file
starts its own `node apps/cli/dist/main.js start --dev --fake <scenario>
--no-open --port 0` with a fresh temporary `AI_OFFICE_HOME`, and drives it only
through HTTP and the dev-only `/dev/fake/*` controls. No test imports server
code. Tests never use `~/.ai-office` or port 4319.

```sh
pnpm -r build                      # the tests run the built CLI, server and web UI
pnpm --dir apps/e2e exec playwright install chromium   # once per Playwright version
pnpm test:e2e                      # functional, login, startup and a11y suites
pnpm test:visual                   # visual regression (compared on Linux CI only)
pnpm e2e:fps                       # load-10 frame timing, 60 s (milestone acceptance)
```

`pnpm e2e:fps` starts a `load-10` workflow with the optional gates off and measures its office; `AIO_FPS_PATH` overrides the page and `AIO_FPS_SECONDS`
(default `60`).

## Writing a spec

```ts
import { expect, test } from '@playwright/test';
import { useOffice } from '../test-support/index.js';

const office = useOffice({ scenario: 'demo' });

test('…', async ({ page }) => {
  await office().login(page, '/');
  // office().api('GET', '/api/v1/…'), office().fake.mergeFinalPr(n), …
});
```

- `useOffice` starts one process per spec file in `beforeAll`. In `afterAll`
  it sends SIGTERM to the CLI, which forwards it to the backend. It escalates to
  SIGKILL on the process group, fails if any process of the group survives or
  if `runtime.json` was left behind, and removes the home. Scenario template
  fixtures (`fixtures/web/templates/<scenario>.yaml`) are copied in first.
- `office().login(page, path)` installs the session cookie and opens `path`.
  The one-time bootstrap URL is used only by `login.spec.ts`.
- `office().fake`: `mergeFinalPr(number)`, `editIssueBody(number, body)`,
  `prStatus(number, { mergeable?, checks? })`, `setConnected(connected)`,
  `hijack()` (another coordinator takes over every open run).
- **The final PR is always merged explicitly** with `fake.mergeFinalPr`. The
  fake never merges it on a timer. Do not use fake timers.
- Feature tasks add their own `tests/<feature>.spec.ts` and add their routes to
  `PAGES` in `tests/a11y.spec.ts`. Only M4-T15 changes `test-support/`.
- `apps/e2e` may import `@playwright/test`, `@axe-core/playwright`, `node:*` and
  **types** from `@ai-office/contracts`. Only `test-support/` may start
  processes (depcruise).

## Visual baselines

`tests/visual.spec.ts` renders the six scene-harness states at 2× and compares
them with zero pixel difference. DOM text is hidden and animations are
disabled. The harness is built and served with `vite preview --config
vite.harness.config.ts` (M4-T8, states mirrored from `HARNESS_STATES`). Baselines live in `tests/__screenshots__/` and
are valid for Linux CI only. On macOS the suite is skipped.

To update them:

1. Run **Update visual baselines**. Add the `update-visual-baselines` label to
   the PR. Once the workflow is on `main`, you can also start it from the
   Actions tab (`workflow_dispatch`) and choose the branch. Re-apply the label
   to render again.
2. Download the `visual-baselines` artifact, review every image, and copy it
   over `apps/e2e/tests/__screenshots__/`.
3. Commit the images in the PR that changed the scene and say why they changed.

Never commit baselines rendered on a local machine.
