# Fake usage

`createFakeUsage({ clock?, source? })` implements `UsagePort` without reading files.
Call `registerAttempt({ attemptId, agent, dispatchId, reportedSessionId?,
transcriptMessageIds? })` and then `append(attemptId, tokens, messageId?)`.
The four token fields are normalized: `inputUncached`, `output`, `cacheRead`, and
`cacheWrite`, with optional `reasoning`.

For Claude, append per-message counts. Duplicate message IDs are ignored, and
reads return new messages with `cumulative: false`. For Codex, append cumulative
session totals; reads return the latest new total with `cumulative: true` and the
stable `usage:<sessionId>:cumulative` key. Computing deltas and budget totals is
the application's responsibility.

Samples and cursors are scoped to attempts. `locate` checks session ID, then
registered dispatch ID, then registered transcript message IDs. Omitted session
IDs receive deterministic fake IDs. Repeating a cursor replays available samples;
reading from the returned cursor without appends yields no samples.

`setSource('none')` makes capabilities unavailable, locate return null, and reads
return no samples without advancing their cursor. Switching back to
`session-log` allows those samples to be consumed. `file` is an opaque fake URI;
no adapter performs filesystem I/O.
