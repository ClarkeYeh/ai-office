# Timeline and replay

`TimelinePage` uses the existing realtime provider. Enter replay explicitly with
“開始回放”; leaving for another view of the same workflow preserves the replay.
“回到即時” exits replay and exposes the latest live model. The app shell shows its
existing replay banner; decision containers must disable mutations whenever
`state.replay !== null`, including while replay loads.

The controller's `getEvents` / `subscribeEvents` exposes the already-paginated
log as a stable read-only snapshot. Timeline never fetches a second history or
mutates the log. Its pure model builds stage attempts, gate / PR markers and
coordination summaries once per snapshot. The scrubber uses event ordinals,
not global sequence increments; Home / End go to actual first / last events.
Forward arrows and the next button use `step()`; backward arrows, pointer seeks,
markers and stage buttons use silent `seek()`. There is no playback speed control.
The coordination list shows at most 50 summaries at or before the selected seq,
never runtime transcripts or command bodies.

## Evidence (2026-11-18)

- [Desktop](evidence/desktop.png): standalone timeline mounted under the real
  realtime provider, using the schema-checked mainline fixture (132 events).
- [Mobile](evidence/mobile.png): 390px viewport on the 5,000-event load case;
  stage buttons scroll horizontally and the other controls fit the viewport.
- Golden component test compares Worker-backed replay to the stored live fold
  at **every one of the 132 mainline events**, including gates, rework and merges.
  The test Worker runs the same replay engine as the browser Worker. Separate
  keyboard tests use sparse global seq values and verify that seeks emit no
  effects, explicit steps emit one event, and live updates remain isolated.
- Local Chromium (Playwright 1.61.1), real browser Web Worker, 5,000 events:
  mainline followed by token updates, paged in batches of 500. Measured 20
  native range-input changes across checkpoint boundaries and arbitrary
  positions, waiting for the requested model and two animation frames each.
  **Maximum 41.9 ms, mean 22.45 ms**, below the 200 ms target; no page errors.
  This is a local UI/Worker measurement, not a backend or cross-machine benchmark.

The supplied screenshot directory contains v3 office/gate/meeting boards but no
v1 Replay image. This implementation applies the specified replay interactions
and v3 shared typography, colors and pixel frame; it does not claim a pixel match
to the unavailable v1 board. No server or contract changes were needed.
