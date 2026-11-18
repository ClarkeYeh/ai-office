# Web event fixtures

Run `pnpm fixtures:web --record` after building dependencies. Run
`pnpm fixtures:web --check` to compare a fresh run with the committed recordings.
The entry point runs a focused Vitest recorder so it can use the existing
acceptance harness and resolve the server TypeScript graph. Each run uses a new
temporary home and an OS-selected port; it never contacts Orca or GitHub.

The recorder drives the real authenticated HTTP API, approves stage gates, and
uses the harness's explicit `mergeOwner()` action for the final PR. It reads
paginated `/events`, omits command arguments, timers, health probes and errors,
and preserves the remaining chronological events. ULIDs, short IDs, hashes,
paths and fake repository URLs are normalized. Branches masked by the API's
entropy scanner receive a synthetic `ai-office/fixture-*` name. Event timestamps
use logical replay time (one second per retained event from the Unix epoch),
not wall-clock performance measurements. The fixtures contain no transcript.

`--check` validates every DomainEvent, replays it through `projection.evolve`,
validates the resulting read model, and compares event counts, gate decisions,
per-item status sequences and semantic final state. On a mismatch, re-record
with `pnpm fixtures:web --record` after reviewing the cause. Do not use these
fixtures to assert exact IDs, event ordering between independent agents, or
latency. For example, an expected `seat.exited` observation can arrive before or
after `gate.decided` without changing the result. The coordinator approved this
semantic comparison in place of byte-identical recordings on 2026-11-18.

`demo` and `parallel` end after explicit final merge. `trouble` records the first
exception cluster; `stall` records an inactive worker; `load-10` records ten
live attempts after their activity burst. The load scenario's production DSL
runs for at least 75 seconds; only tests/recordings use accelerated pacing.

The fixture scanner applies a schema-aware rule only to
`fixtures/web/*.events.json`, rejects private event types and transcript fields,
and scans every string/key with the shared secret scanner. Only
`fixtures/web/templates/*.yaml` may contain YAML. Other fixture paths retain
the existing generic redaction rules.
