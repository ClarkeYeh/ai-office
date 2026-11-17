# Server redactor

`createRedactor({ defaultBranch, preservedRepoUrls? })` implements the Redactor
port. The composition root must supply the repository's default branch and any
public test-repository URLs it deliberately preserves. No URLs are preserved by
default. Instantiate per repository when default branches differ.

`toActivity` emits metadata only. Known tool names are normalized to a fixed
allowlist; unknown names are omitted and classified as `other`. Input/output
lengths count UTF-8 bytes (strings directly, other values as JSON). Input hashes
are SHA-256 of JSON encoding, including quotes for string inputs; absent input
is the empty string. Results are paired by tool-use ID within a message; results
received in separate messages remain standalone `other` activities. No transcript
or pending tool input is retained between calls. Fractional durations are floored
to satisfy the integer activity contract. Message IDs are runtime-supplied
identifiers and are preserved for correlation.

Policy scanning examines string inputs and nested `cmd`, `command`, or `script`
fields of tool inputs, before masking. It does not scan narrative text, tool
results, or artifact body fields. A small shell lexer supports quoted tokens,
absolute executable paths, line continuations, command separators, environment
assignments, common wrappers, and shell `-c` commands. Each rule appears at most
once per message. Git refspec detection examines the destination branch, including
forced and fully qualified refspecs; `--all` and `--mirror` are conservatively hits.

The spec does not assign severity per rule. This adapter treats dispatch, run
ownership, worker termination, agent launch, merge, and default-branch pushes as
`high`; GitHub comments and labels are `medium`. This is observation, not a shell
security boundary: aliases, variable expansion, computed commands, arbitrary
interpreters, global Orca/GitHub options before subcommands, and implicit Git push
destinations are not resolved. Runtime and SCM anomaly detection remain necessary.

`maskSecrets` recursively preserves artifact structure and readable text, using
the shared redaction package for secret-field detection, text masking and URL
policy. It intentionally does not apply the fixture sanitizer's body summarization.
Key collisions after masking throw a generic error; inputs are not mutated.
