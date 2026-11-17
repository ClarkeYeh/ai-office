# SQLite stores

`openSqliteStores<T>({ filename, clock, ids, projectionVersion })` opens one
connection and returns `events`, `projections`, `seatTokens`, `sessions`,
`idempotency`, `backupPath`, and `close()`. The composition root supplies its
Clock, IdGen, and the current projection package version. Close the stores after
stopping their consumers. The data directory must already exist.

File databases use WAL and FULL synchronous mode. Pending migrations run in one
transaction, tracked by `PRAGMA user_version`. Before migration, `VACUUM INTO`
creates a consistent sibling backup including committed WAL pages; its path is
returned as `backupPath`. Current databases do not create another backup.
In-memory databases have no backup file. Database and backup files use mode 0600.

The numbered SQL files are runtime assets. Source execution and the repository's
`tsc` build both resolve them from this tree. For a dist-only distribution, copy
`migrations/*.sql` beside the compiled migration module, or pass
`migrationDirectory` explicitly. Do not ship only the JavaScript without SQL.

Event and cursor writes commit together. Duplicate external keys are skipped;
other constraint failures roll back the entire batch. Subscribers are notified
synchronously after commit, in sequence order even through reentrant appends.
Notifications are local to this store instance; all application event writes
should use the shared instance. Subscriber failures do not turn a committed
append into a failed operation. Event IDs come from the supplied IdGen.

Optional `upcasters` map event types to a current version and one payload
transform per older version. Reads upgrade in memory and validate against the
current contract without rewriting history. All production event types currently
use version 1; tests demonstrate a v1-to-v2 upgrade. New appends must already use
the current version. Missing steps and future versions fail explicitly.

Projection version mismatches return null for rebuilding by the consumer. The
low-level projection class can omit version filtering for the shared port
contract suite; the factory always requires `projectionVersion`.

Seat tokens, bootstrap codes, and sessions use 256-bit random secrets and persist
only SHA-256 hashes. Revoked seat-token rows remain as issuance tombstones.
Bootstrap exchange is atomic, expires after 60 seconds, and creates a 30-day
session. Idempotency writes preserve the first live response and report
`idempotency_mismatch` for a different request hash. Expired records are ignored;
expired idempotency rows are replaced when their key is reused.
