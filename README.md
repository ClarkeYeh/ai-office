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
pnpm test              # Run all eight Vitest workspace projects
pnpm lint              # ESLint flat config and Prettier check
pnpm typecheck         # tsc -b: build the TypeScript project-reference graph
pnpm contracts:gen     # TODO: generate OpenAPI / JSON Schema
pnpm contracts:check   # TODO: check committed contract artifacts
pnpm depcruise         # TODO: enforce architectural dependency rules
pnpm depcruise:selftest # TODO: verify intentional violations are rejected
pnpm check:bundle      # TODO: inspect the frontend bundle
pnpm fixtures:scan     # TODO: scan sanitized fixtures
```

The six commands marked TODO are successful placeholders for the remaining M0
work. Their success does not yet verify contracts, architecture, bundles, or fixtures.
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
Server layer rules and contracts subpath restrictions will additionally be enforced
by the dependency-cruiser task.

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
entry points have smoke tests until their feature tests replace them.

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
