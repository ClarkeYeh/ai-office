# Stream transport integration

`new StreamService(eventStore).open({ workflowId?, afterSeq? })` returns an async
iterator of logical `domain` and `resync_required` frames. The event store must
contain already-redacted events and publish notifications after commit in seq
order. Without `workflowId`, all workflow and system events are included.

The SSE layer resolves Last-Event-ID versus the query cursor before opening,
encodes frames, and sends 15-second keepalive comments. Request the next iterator
entry only after the transport accepts the previous one (including waiting for
socket drain); do not copy frames into an unbounded transport queue. Call
`return()` or `close()` on disconnect. Only one pending `next()` is supported.

Opening subscribes before reading history, merges by seq, and deduplicates the
handoff. More than 1000 pending events, including the initial history backlog,
replaces the queue with `resync_required` and detaches the subscription. After
that frame the iterator ends; close the SSE connection so the client fetches a
new snapshot. History read failures detach the subscription and propagate.
