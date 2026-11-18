# AI Office

A gated workflow layer for multi-vendor AI coding agents — from discussion to PR — with a virtual office as the main UI.

> Status: early development (M0 skeleton). Not ready for use.

## Development

Prerequisites: Node.js 24 (see `.nvmrc` / `.node-version`) and pnpm 10.34.9
(the version pinned in `packageManager`). Install pnpm with
`npm install --global pnpm@10.34.9` if it is not already available.

```sh
pnpm install
pnpm build             # Build all workspaces, including the Vite frontend
pnpm -r build          # Equivalent recursive build
pnpm test              # Run workspace and fixture tests
pnpm lint              # ESLint flat config and Prettier check
pnpm typecheck         # tsc -b: build the TypeScript project-reference graph
pnpm contracts:gen     # generate OpenAPI / JSON Schema
pnpm contracts:check   # check committed contract artifacts
pnpm depcruise         # enforce architectural dependency rules
pnpm depcruise:selftest # verify intentional violations are rejected
pnpm check:bundle      # inspect the frontend bundle
pnpm fixtures:scan     # scan sanitized fixtures
```

These commands validate generated contracts, dependency boundaries, bundle contents,
and sanitized fixtures. Run `pnpm test:scripts` for validation-script regressions and
`pnpm test:coverage` for the pure-package coverage gate.
Run `pnpm format` to apply Prettier formatting.

Run `pnpm --filter @ai-office/web dev` for the placeholder web page. After a build,
run `node apps/cli/dist/main.js --help` for CLI usage (the package exposes this
entry point as the `ai-office` bin when installed); `submit`
and `start` are stubs and exit with status 1 until implemented. The server exports
`createServer()` from its composition root without opening a listener on import.

The workspace graph is contracts → projection/domain → engine → server, with
web depending only on contracts and projection, CLI only on contracts, and the
independent templates package consumed by server. Here arrows indicate build order;
engine depends on domain and contracts, not projection. Each package declares only
its permitted workspace dependencies and TypeScript references. There are no global
source aliases or root workspace dependencies, and pnpm hoisting is disabled, so
undeclared workspace imports cannot resolve through a shared root dependency.
Server layer rules and contracts subpath restrictions are additionally enforced
by dependency-cruiser.

Vitest workspace configuration uses `test.projects` in `vitest.config.ts` (the
current name for workspaces). Production TypeScript projects exclude test files;
Vitest runs them separately. Web declarations go to `dist/types`, while Vite writes
the runnable site and a manifest to `dist`.

## Architecture boundaries

`pnpm depcruise` enforces SPEC §23 across the repository, including type-only
and side-effect imports. Contracts expose subpaths (`api`, `events`, `stream`,
`template`, `agent-submission`); consumers must not import the contracts root.
Domain and engine use only events/template contracts. Application code uses
ports, pure packages, and its allowed contract subpaths; adapters cannot import
one another. Ports additionally permit `zod` (architect review decision).
Only `server/main.ts` composes the application. Templates are consumed only by
`template-fs` and that composition root.

The config contains the complete layer allowlists and npm/builtin placement
rules. React and React DOM are the initial web UI package allowlist; add future
UI dependencies explicitly. Tests may import their subjects and fakes, while
production cannot import tests. UI components cannot reach API/realtime clients;
the office scene imports only its own view-model types, and cross-feature imports
use feature `index.ts` entry points. Cycles, unresolved imports and orphan modules
fail the check (config and test files are exempt from orphan checking). Skeleton
entry points are discovered by smoke tests only while they contain an empty export.
The depcruise runner temporarily materializes those dynamic import edges so real
unreferenced implementations still fail the orphan rule.

`pnpm depcruise:selftest` runs isolated violating and allowed samples through the
same config and resolver, asserting every rule fires and the CLI fails. Samples
are excluded from production cruising, linting and workspace compilation.
`noUncheckedSideEffectImports` also makes unresolved side-effect imports fail
`tsc -b`. `tsconfig.depcruise.json` maps workspace aliases to source so checks do
not depend on stale build output.

After `pnpm --filter @ai-office/web build`, run `pnpm check:bundle`. Vite emits a
manifest plus Rollup module stats, including external and tree-shaken imports.
The check fails on missing metadata, server/Octokit/SQLite/Node module IDs, or
`child_process` / `orca orchestration` strings anywhere in the output. Run
`node --test scripts/check-web-bundle/index.test.mjs` to exercise rejection cases.
Import rules cannot inspect the arguments passed to process APIs: config's
`gh auth token` limitation and CLI start behavior still require code review.

## Pixel-office sprites

The office art is drawn in code: `apps/web/src/features/office/scene/sprites/` holds
the palette, ASCII sprite maps and the floor plan as pure TypeScript data.
`pnpm sprites` exports them to `apps/web/src/features/office/scene/assets/` (three
atlas sheets, four background strips and `atlas.json`); a PNG is rewritten only when
its decoded pixels change. `pnpm sprites:check` (also in CI) fails when the committed
output is stale, when a pixel is outside the palette, when amber or red appears
outside the sprites allowed to use them, or when the atlas layout is invalid.
`pnpm sprites --sheet <dir>` writes a `sprites-sheet.html` review page. The original
Python sources and mock-up screenshots are kept in `tools/sprites-src/`.

### Acknowledgements

- The scene uses only the [Endesga 32](https://lospec.com/palette-list/endesga-32)
  palette by Endesga.
- All characters, props and effects are drawn for this project.
- The bundled ASCII pixel font (`AI Office Pixel`) is a subset of
  [DotGothic16](https://github.com/fontworks-fonts/DotGothic16) by the DotGothic16
  Project Authors, under the SIL Open Font License 1.1; see
  `apps/web/src/shared/fonts/`.
