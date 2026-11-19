# Shared ScmPort contract recordings

No live recordings are included in the initial T8 PR. The coordinator explicitly
reserved all live calls for the integrator (M3_PLAN §1.4). Missing recordings are
reported as pending tests, not passing contract evidence. T1 probe envelopes are
not scenario recordings and are never substituted here.

After review and T5 PR-method assembly, the integrator runs, serially:

```sh
AIO_REAL_GITHUB=1 pnpm test:github:record
pnpm exec vitest run apps/server/src/adapters/scm-github/contract.test.ts apps/server/src/adapters/scm-github/recording.test.ts --maxWorkers=2
pnpm fixtures:scan
```

The first command refuses CI, verifies the selected and active account, quota,
and spike-only repository, acquires the T7 live lock, and uses the guarded T7
transport and git pusher. Each case performs janitor cleanup and an open-object /
branch scan before releasing the lock. The shared cases run serially, and the
live project disables file parallelism. Output lists actual method/path calls,
leftovers and scan results. Never run a second live suite concurrently. No merge
into main, settings mutation, alternate account, or legacy PUT merge is available.

Each case writes a separate tape named by SHA-256 of the shared case name. The
tape includes start time, strictly matched push inputs/results, and sanitized
HTTP recordings. Run IDs normalize to `000000000001`. Request bodies are stored
only as hashes; response bodies use hash/length summaries. Replay rehydrates
known synthetic values from requests. Unknown bodies use the T7 deterministic
placeholder. Review every tape before committing; rerun the offline commands
above. Writes use `wx`: move prior recordings aside deliberately before replacing
them. A failed or skipped case must not publish a tape.

The binding adds run prefixes to remote titles/command markers and removes them
from responses so the shared suite remains unchanged. Collection responses are
scoped to this run before recording, while preserving pagination headers. It
does not replace the adapter or copy the contract assertions. External body edits
retain the ownership marker needed for safe cleanup. Lost responses and list lag
are explicitly injected locally after recording real responses; `settle` advances
the scenario clock. These cases do not claim GitHub actually lost a response or
exhibited the injected lag.

Pending / intentionally unavailable live controls:

- PR-method cases skip while T5 assembly still returns `not_implemented`.
- External final-PR merge and default-branch push are never supplied (GD).
- PR retargeting is not supplied: T7 forbids PATCH base. Existing adapter unit
  tests cover retarget behavior; the shared fake and gitremote bindings cover it.
- The encoded-ref probe explicitly creates, reads, deletes and rereads a branch
  with `%2F`-encoded slashes through `/git/ref/heads` and `/git/refs/heads`.
- `Base branch was modified` (405/409) is an explicit pending recording probe:
  there is no safe deterministic reproducer for POST /merges yet. Do not use
  the removed PUT merge endpoint to obtain this response.
- 405 rules-blocked wording is an explicit pending recording probe: the harness
  refuses protected merge bases, and changing rulesets is outside authorization.
  Preserve the gap rather than manufacture a real-provider fixture.

T8 makes no contract/schema additions. All existing names remain those registered
in M3_PLAN §8. The integrator's final report must distinguish replay/live passes,
skips, actual status responses, and zero-leftover evidence.
