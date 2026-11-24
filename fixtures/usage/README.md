# Session usage fixtures

Synthetic, usage-only records matching the provider shapes documented in SPEC §10.2.
No transcript bodies, credentials, or local profile paths are included. Tests serialize
these arrays to temporary JSONL files to exercise byte cursors and partial writes.
Claude repeats message ids; Codex records cumulative totals with cached input included.
Real provider numeric validation remains M2-T17's responsibility.

The fixture CLI preserves known non-negative integer counters only for recognized
provider records at paths under this directory. Strings, unknown counter fields,
and the same fields elsewhere remain subject to normal redaction. The sanitizer
uses its input file path to select this rule; stdin retains the conservative rules.

## Real-format samples (M5-T1)

`claude-code-2.1.311.json` and `codex-0.171.0.json` are usage-only projections of
one real session each (an Orca Claude worker and an Orca Codex worker, recorded on
2026-11-24). Only the record type, timestamp, stop reason and non-negative integer
counters are kept; message ids are replaced by placeholders. Both parse with the
adapter's parsers. Relative to the synthetic files, Claude Code 2.1.311 adds
non-counter usage keys (`service_tier`, `speed`, `iterations`, ...) that are ignored,
and codex-cli 0.171.0 adds `cache_write_input_tokens` to `total_token_usage`
(0 in every record of this session), which the adapter maps to `cacheWrite`.
