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
