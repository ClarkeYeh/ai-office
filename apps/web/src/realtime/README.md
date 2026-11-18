# realtime

Server state for the web app: one global SSE stream → `projection.evolve` → a
Zustand vanilla store, plus overview refetch, Worker-backed replay and the
`AppliedEvent` bus (M4_PLAN §3.3–3.4). No view derivation happens here.

`app/` creates one instance and provides it to React:

```ts
const realtime = createBrowserRealtime(api);
void realtime.start();
<RealtimeProvider realtime={realtime}>…</RealtimeProvider>;
```

Only `react.ts` imports React; everything else is plain TS and runs in Node tests.

## Store (`WebState`)

`auth`, `connection {status, cursor, catchingUp}`, `overview {workflows, gates,
questions, health, repos}`, `active {workflowId, live, status}`, `replay`.
`selectDisplayedModel` returns `replay?.model ?? active.live`, so replay is
transparent to features. The reference changes only when an event is applied or the
replay position moves.

## Hooks (`connect/` and `app/` only)

- `useDisplayedModel()`: the displayed read model.
- `useViewModel(selector, args, stabilize?)`: computes the VM outside the store
  selector. It reruns only when the model, the selector, or a shallow value of `args`
  changes. Pass a module-level selector, and pass `shared/lib` `stabilize` (M4-T5) so
  unchanged sub-trees keep their identity. The default is identity.
- `useWebState(selector)`: other store fields. Selectors must return stable references.
- `useNow()`: wall clock from the global 30-second ticker.
- `useAppliedEvents(listener)`: the bus, for the component's lifetime.

## Stream

- **Start (lower bound)**: take the active workflow's snapshot, or else the newest
  workflow's snapshot (0 when there is none). Then open
  `/api/v1/stream?afterSeq=<bound>` (global, no `workflowId`). Only then fetch the
  overview.
- **Apply**: `seq ≤ cursor` is skipped. Events of the active workflow are queued and
  `evolve`d once per animation frame, with one `setState` per frame. A 100 ms timer
  covers hidden pages that get no rAF. Each event that changes the model emits one
  `AppliedEvent`. Nothing is emitted while a replay is open.
- **Background**: an event is background when it was recorded before the current
  connection opened (backlog), when its `occurredAt` is more than 10 s ago, or when
  the page is hidden. `connection.catchingUp` is a UI flag. It is set after an open
  until the stream is quiet for 250 ms (at most 3 s), and during resync and `/events`
  gap fills. It does not silence live events.
- **Overview**: `gate.*`, `message.escalated/answered`, `workflow.*`, `stage.*`,
  `usage.tokens`, `health.changed`, `runtime.identity_*` and `repo.*` schedule a
  refetch of the affected endpoints 250 ms after the first signal. Later signals do
  not reset the timer, so a busy stream cannot starve the refetch. Out-of-order
  responses are dropped.
- **Reconnect**: the browser's own reconnect resends `Last-Event-ID`. Once the
  EventSource is `CLOSED`, we wait 1 → 30 s (exponential), probe `GET /health`, then
  reopen at `cursor`. A 401 sets `auth = 'missing'` and stops reconnecting.
- **`resync_required`**: close immediately, then reload the active snapshot (never
  moving it backwards; the screen is not cleared), reopen at the new bound, and
  refetch the overview.
- **Switching active**: the stream stays open. The last 2,000 events per workflow are
  kept. After the snapshot loads, events with `seq > asOfSeq` are applied from that
  buffer. If the buffer no longer reaches back that far, `/events` fills the gap.

## Replay

`realtime.replay.open(id)` pages `/events?limit=500`, reporting progress, and sends
each page to `replay.worker.ts`. The worker builds checkpoints incrementally (the
same positions as `createCheckpoints`) and answers `seek(seq)` with
`replayWithCheckpoints`. A drag coalesces in the worker, and the main thread drops
stale answers; no `AppliedEvent` is emitted. `step()` applies the next event on the
main thread and emits it as non-background. Live events for the replayed workflow are
forwarded to the worker. `exit()` returns to live.
