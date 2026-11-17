# Projection

`evolve(initialReadModel(), event)` creates a workflow read model when it sees
`workflow.started`. Before that event the model is `null`. Supply schema-valid,
upcasted events in increasing global `seq` order. Missing referenced entities are
ignored; the reducer does not validate domain commands or fabricate entities.
Duplicate or older sequences, and events for another workflow, return the input
object unchanged. Accepted events return a new model without mutating inputs.

The model is the contracts `WorkflowReadModel`, including accepted artifact
submissions and budget-to-gate links. It can be serialized, validated with
`WorkflowReadModelSchema`, and resumed directly with SSE events. There are no
hidden caches. Gate content resolves the exact referenced artifact rather than
whichever submission happened most recently. Activity is metadata only, newest
last, capped at 20 entries per seat across attempts. Historical attempt updates
do not replace the current attempt's seat presentation.

`initialGlobalReadModel(runtimeMode?)` and `evolveGlobal` fold the global stream
into workflow views, workflow summaries, the open-gate inbox, escalated questions,
registered repos, and health. The runtime mode is supplied by composition because
health events do not carry it. Components start degraded/unverified until observed;
identity restoration does not itself assert that runtime health recovered.
Global state uses the same global sequence watermark, so clients should consume
the complete global stream rather than combine independently filtered streams.

`replay(events, toSeq?, checkpoint?)` folds one workflow's stream up to an inclusive
sequence. `createCheckpoints(events)` returns a snapshot after each 500 applied
events (not every 500 global sequence numbers); duplicates and other workflows do
not count. `replayWithCheckpoints(events, toSeq, checkpoints)` selects the latest
compatible checkpoint at or before the target. Keep the full ordered event stream
available for backward seeks and projection-version rebuilds. Storage, scheduling,
and eviction belong to the caller. `PROJECTION_VERSION` must change when persisted
projection semantics change.

Usage is summed from recorded deltas, including historical attempts. Budget bars
use those totals and recorded event timestamps, never the current clock; wallclock
bars are measured in milliseconds. Explicit budget observations supply their
recorded thresholds and gate links. Top-ups change only the linked token bar,
including after snapshot restoration, and leave the start-time budget snapshot
and other items unchanged. A PR artifact appears immediately in the artifact tray;
its full PR summary becomes available when `pr.status` supplies the head SHA and
mergeability.

Intent-only events (rerun requests, nudges/instructions, rejected submissions,
unmanaged-agent observations, outbox issue/success/reconcile, and timers) advance
the watermark without inventing a UI entity. Their resulting state changes arrive
as the corresponding domain facts. Command failures and recorded errors populate
error views. System events affect the global view; workflow projection ignores
system events whose `workflowId` is null.

Implement stages expose independent `ondemand.oncall` and `ondemand.merge` views.
`ondemand.queue_changed` supplies the ordered queue and current item: question IDs
for on-call and work-item keys for merge review. Resolve merge keys through
`workItems` to their PR summaries; seat `currentAttemptId` selects the attempt's
`ondemand.purpose`, preserving prior purposes in attempt history.
Work-item facts project queued/review/rework/merged states, the recorded rework
counter (not a locally incremented count), review reasons, current dispatch base
SHA, and merge commit SHA. Rework requests identify the reviewer and never replace
the worker's current attempt. PR summaries remain SCM observations from
`pr.status`; `workitem.merged` establishes item completion before that observation.
Projection version 2 rebuilds version 1 checkpoints to include these facts.
