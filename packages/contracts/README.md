# Contracts

Import only `/events`, `/template`, `/api`, `/stream`, or `/agent-submission`.
There is deliberately no root export. RuntimePort events belong to server ports,
not this package. Production schemas depend only on Zod.

Run `pnpm contracts:gen` after editing schemas and commit `generated/`.
`pnpm contracts:check` builds current sources, generates into a temporary directory,
compares both the file list and bytes, and removes the temporary output.

Zod 4's native JSON Schema converter avoids another schema conversion dependency
and emits draft 2020-12, which OpenAPI 3.1 supports. The endpoint registry supplies
methods, paths, parameters, security, and request/response schemas for OpenAPI.
Zod schemas remain the source of truth. JSON Schema cannot express the template's
cross-field reference, uniqueness, and ordering checks; consumers must implement
those checks separately or use the exported Zod schema. The generated template
schema includes a comment recording that limitation.

M0 event payloads and projection read models are intentionally extensible skeletons.
API shapes not specified in detail (budget overrides, list wrappers, acknowledgments,
merge results) are provisional until M1. Template filesystem checks (filename equals
id) and contextual request validation (role overrides, gate toggles, work-item graphs,
authorization, and workflow state) belong to adapters/application rather than these
transport schemas. `final-pr` gates must omit `optional`, including `optional: false`.

SSE schemas describe logical frames: domain frames carry an event and sequence ID,
resync frames request a fresh snapshot, and keepalive frames encode as the comment
`:keepalive` every 15 seconds. The wire encoder must ensure domain frame IDs equal
the enclosed sequence. SSE authentication uses the same session cookie as other API
routes; submission authentication uses a seat token, with terminal/session headers
and the documented token-only fallback enforced by the gateway.

Built-in YAML is in `packages/templates`, with budgets pending M2 calibration.
Only the server template filesystem adapter and composition root may import that
package. Contract tests read its fixture directly and validate it with the schema.
