# Session-log usage adapter

`createSessionLogUsage({ claudeConfigDirs, codexHomes, clock? })` implements
`UsagePort` without subprocesses or writes to provider directories. The composition
root supplies configured directories (including any resolved provider environment
overrides). `homeDir` defaults to the OS home and can be overridden in tests.

Discovery tries reported session ids first, then dispatch markers, then exact
transcript message ids. Configured roots precede Orca's observed Claude roots or
managed Codex home, then provider defaults. Forward the attempt's ISO `startedAt`
into `UsageLocateRef`: fallback searches exclude older files. Legacy callers that
omit it use a rolling 24-hour window. An explicit reported session id is not age
filtered. Unreadable or missing candidates are skipped; an absent session is null.

Reads return Claude per-message counters and Codex cumulative counters. The existing
application observation layer computes Codex deltas and persists deduplication
keys; this adapter must not subtract them a second time. Claude uses the last line
for a message in a read, waits for a stop reason, a subsequent message, or 30 seconds
of file inactivity (SPEC §10.2; the older T7 plan said 60 seconds).

Cursors are versioned JSON with a byte offset and unfinished numeric samples,
bound to the attempt, provider, session, and file. Persist the returned cursor only
with the samples' transaction. No transcript text is retained in a cursor or error.
Reads are capped at 4 MiB per batch; an incomplete tail is retried on the next read.
A single line exceeding that cap is unavailable rather than silently skipped.

Malformed records, invalid counters, missing files, and truncation throw a fixed
`usage_unavailable` error, retain the caller's checkpoint, and mark capabilities
`source: none, formatVerified: false`. A successful retry clears that file's failure;
other failed files remain degraded until successfully read. Unknown record types
are ignored; recognized usage records are validated. Synthetic usage fixtures test
the supported formats; initial format verification reflects these passing contract
tests, not a claim that the installed providers were probed. Real numeric validation
belongs to T17; wiring and attempt start forwarding belong to T10.
