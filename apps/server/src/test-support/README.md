# Port test support

Import runtime helpers from `stores.ts` or `services.ts`. Import reusable Vitest
suites from `contracts.ts`; `index.ts` also exports all three modules for tests.
These helpers must never be imported by production code.

Each contract factory returns a fresh `{ store, dispose? }`; async setup and cleanup
are supported so SQLite adapters can use a temporary database. The seat-token
factory additionally supplies `storedHashes()` returning `{ hash, attemptId }[]`
from persistence. Run `eventStoreContract(factory)`,
`projectionStoreContract(factory)` and `seatTokenStoreContract(factory)` inside the
adapter's test file. The projection suite uses `ContractReadModel` to test storage
without coupling the adapter to a specific projection version.

## Semantics made explicit for downstream adapters

- `EventStore` validates an entire append before commit, skips repeated external
  keys globally, commits cursors even on empty/duplicate batches, then notifies in
  sequence order. Reentrant appends queue their notifications after the current
  batch. Listener exceptions cannot invalidate an already committed append.
  Reads and notifications do not expose mutable stored references. `workflowId`
  omitted means all events; `null` selects system events. `limit: 0` returns none.
- `ProjectionStore<T>` keeps its consumer's model type generic: ports cannot import
  projection or contracts/api. Checkpoints are best-effort caches; the caller owns
  schema-version checks and replay after `asOfSeq`.
- A seat token is issued once per attempt, including after revocation. Repeated
  issue is a conflict; recovery must reuse the persisted spec rather than mint a
  new token. The memory implementation uses random secrets and SHA-256 hashes.
- Bootstrap codes expire after 60 seconds and are atomically consumed by exchange;
  sessions expire after 30 days. Expiration is exclusive (`now >= expiry` is
  invalid). Both stores persist only hashes. These new method names fill the
  otherwise unspecified SessionStore API in SPEC §11.3 / M1_PLAN Q2.
- Idempotency entries are scoped by caller-selected operation scope plus key.
  First response wins for a matching request hash; a mismatch is a conflict.
  Expired records can be reused. Application owns canonical request hashing,
  expiration policy, and serialization of concurrent in-flight requests.
- `FakeClock.advance()` does not fire timers implicitly; call
  `ManualScheduler.runDue()`. Due timers fire by timestamp then ID. Scheduling
  the same timer ID replaces it. `SeqIdGen` emits deterministic IDs and actual
  UUIDv5 request IDs using the fixed `AIO_NAMESPACE` exported by ports.
- `PassthroughRedactor` intentionally masks nothing and emits no activity or
  policy hits. Use it only with synthetic test input.
- Runtime refs/cursors are branded serialized strings, matching T1's serialized
  command args. Only adapters interpret their contents. `inspectLocalRepo` uses
  M1_PLAN §8 Q5 names (`orcaRepoId`, `remoteUrl`, `isMainWorktree`), authoritative
  over the different names in SPEC rev2.5.
