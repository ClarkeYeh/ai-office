# Development

Working on AI Office itself. Install the toolchain first ([Install](install.md)).

## Layout

A pnpm monorepo in TypeScript:

| Path                  | What                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `packages/contracts`  | API, event, stream, template and agent-submission schemas (Zod)     |
| `packages/domain`     | Pure workflow model and decisions                                   |
| `packages/engine`     | Stage modules and policies, pure                                    |
| `packages/projection` | Read models from events, pure                                       |
| `packages/redaction`  | The single set of masking and secret-pattern rules                  |
| `packages/templates`  | Built-in workflow templates                                         |
| `apps/server`         | Backend: application, ports, adapters (Orca, GitHub, SQLite, fakes) |
| `apps/web`            | Frontend (React, Vite) with the pixel office                        |
| `apps/cli`            | The `ai-office` command                                             |
| `apps/e2e`            | Playwright tests                                                    |
| `fixtures/`           | Sanitized recordings and test data                                  |
| `scripts/`            | Repository checks and harness runners                               |

## Commands

```sh
pnpm install
pnpm build              # build all workspaces, including the Vite frontend
pnpm test               # workspace and fixture tests
pnpm lint               # ESLint flat config and Prettier check
pnpm format             # apply Prettier
pnpm typecheck          # tsc -b over the project-reference graph
pnpm typecheck:tests    # typecheck test projects and scripts
pnpm contracts:gen      # generate OpenAPI / JSON Schema
pnpm contracts:check    # check committed contract artifacts
pnpm depcruise          # enforce architectural dependency rules
pnpm depcruise:selftest # verify intentional violations are rejected
pnpm check:bundle       # inspect the frontend bundle
pnpm fixtures:scan      # scan sanitized fixtures
pnpm docs:check         # public docs: no private links, no unsafe text
pnpm test:scripts       # validation-script regressions
pnpm test:coverage      # pure-package coverage gate
pnpm test:e2e           # Playwright, for changes under apps/web
```

On a shared machine, limit workers: `pnpm test --maxWorkers=2`. Do **not**
write `pnpm test -- --maxWorkers=2`: vitest ignores everything after `--`.
While iterating, run only the relevant tests:
`pnpm exec vitest run <path> --maxWorkers=2`.

### Definition of done

A change is ready when all of these pass locally (the same as CI):

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm typecheck:tests && pnpm -r build && pnpm lint && pnpm test --maxWorkers=2
pnpm test:scripts && pnpm test:coverage --maxWorkers=2
pnpm depcruise && pnpm depcruise:selftest && pnpm contracts:check
pnpm check:bundle && pnpm fixtures:scan && pnpm docs:check
```

Changes that touch `apps/web` also run `pnpm test:e2e`.

## Running locally

```sh
pnpm dev:office --fake demo --open
```

This starts the backend in fake mode with a fresh `.dev-home/<scenario>-*` data
directory and a random port, plus the Vite dev server with hot reload
([Usage](usage.md#fake-mode)). Development never uses `~/.ai-office` or port 4319.

`node apps/server/dist/main.js --dev --runtime orca` is a hybrid mode for
development: real Orca with a simulated GitHub. It uses the Orca folder given
by `--orca-home <abs-path>` or `orca.homeDir`. Production (`ai-office start`
without `--dev`) is the only mode that talks to GitHub.

## Architecture boundaries

The workspace graph is contracts → projection/domain → engine → server, with
web depending only on contracts and projection, the CLI only on contracts, and
the independent templates package consumed by the server. Arrows show build
order; engine depends on domain and contracts, not projection. Each package
declares only its permitted workspace dependencies and TypeScript references.
There are no global source aliases or root workspace dependencies, and pnpm
hoisting is disabled, so undeclared workspace imports cannot resolve.

`pnpm depcruise` enforces the dependency rules across the repository,
including type-only and side-effect imports:

- Contracts expose subpaths (`api`, `events`, `stream`, `template`,
  `agent-submission`); consumers must not import the contracts root.
- Domain and engine use only the events and template contracts. Application
  code uses ports, pure packages and its allowed contract subpaths. Adapters
  cannot import one another. Ports may also use `zod`.
- Only `apps/server/src/main.ts` composes the application. Templates are
  consumed only by `template-fs` and the composition root.
- React and React DOM are the web UI's package allowlist; add UI dependencies
  explicitly. UI components cannot reach API or realtime clients; the office
  scene imports only its own view-model types; cross-feature imports go through
  each feature's `index.ts`.
- Tests may import their subjects and fakes; production cannot import tests.
- Cycles, unresolved imports and orphan modules fail the check (config and test
  files are exempt from orphan checking).

`pnpm depcruise:selftest` runs isolated violating and allowed samples through
the same config and resolver, asserting that every rule fires. `tsconfig.depcruise.json`
maps workspace aliases to source, so checks do not depend on stale build output.
`noUncheckedSideEffectImports` makes unresolved side-effect imports fail `tsc -b`.

After a web build, `pnpm check:bundle` reads Vite's manifest and Rollup module
stats. It fails on missing metadata, server, Octokit, SQLite or Node module
IDs, or `child_process` / `orca orchestration` strings anywhere in the output.

Import rules cannot inspect arguments passed to process APIs: that `config/`
only ever runs `gh auth token`, and how the CLI starts the backend, still need
code review.

Vitest uses `test.projects` in `vitest.config.ts`. Production TypeScript
projects exclude test files; Vitest runs them separately.

## Fixtures

Recorded Orca and GitHub responses live under `fixtures/`, sanitized: no
tokens, emails, transcripts or free text from agents. `pnpm fixtures:scan`
enforces that with the shared rules from `packages/redaction`. Contract tests
replay the recordings strictly. See `fixtures/README.md` and the README next to
each fixture set for how they were recorded.

## Live suites

Some suites run against real Orca, real GitHub and real agents. They are
**off by default and skipped in CI**, and are meant for the maintainer only:

| Gate                | Enables                                          |
| ------------------- | ------------------------------------------------ |
| `AIO_REAL_ORCA=1`   | Orca contract and smoke suites (`test:orca`)     |
| `AIO_REAL_AGENTS=1` | Suites that start real agents                    |
| `AIO_REAL_GITHUB=1` | GitHub suites (`test:github`, `test:github:e2e`) |

Rules the harnesses enforce:

- Writes go only to the dedicated test repository
  `ClarkeYeh/ai-office-spike`, and only under test namespaces. Nothing is ever
  merged into its `main`.
- A machine-wide lock serializes live suites. Every object created is recorded
  in a ledger and cleaned up; a run ends with zero leftovers.
- The harness checks that the active `gh` account is the expected one and never
  switches accounts.
- Credentials, raw responses and transcripts are never persisted. Recordings
  are sanitized before they are saved.

Details: `apps/server/src/test-support/orca/README.md` and
`apps/server/src/test-support/github/README.md`.

## Pixel-office sprites

The office art is drawn in code: `apps/web/src/features/office/scene/sprites/`
holds the palette, ASCII sprite maps and the floor plan as pure TypeScript data.

- `pnpm sprites` exports them to `apps/web/src/features/office/scene/assets/`
  (three atlas sheets, four background strips and `atlas.json`). A PNG is
  rewritten only when its decoded pixels change.
- `pnpm sprites:check` (also in CI) fails when:
  - the committed output is stale;
  - a pixel is outside the palette;
  - amber or red appears outside the sprites allowed to use them;
  - the atlas layout is invalid.
- `pnpm sprites --sheet <dir>` writes a `sprites-sheet.html` review page.

The original Python sources and mock-up screenshots are kept in
`tools/sprites-src/`.

## Pull requests

Branch from the current integration branch and open a PR. Do not put tokens,
emails, transcripts or other private data in code, fixtures, logs or PR
descriptions.
