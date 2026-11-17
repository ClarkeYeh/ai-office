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
