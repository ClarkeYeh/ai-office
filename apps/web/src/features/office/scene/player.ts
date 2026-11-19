import type { Effect } from '../model/index.js';

// Effect queue (M4_PLAN §3.6): at most 8 effects play at once; when more than 20
// wait, the rest jump straight to their result (the floor already shows it, so
// skipping means dropping). Pure, so the caps are unit-tested without a DOM.

export const MAX_PLAYING = 8;
export const MAX_WAITING = 20;

/** An effect handed to the scene; ids increase in arrival order. */
export type QueuedEffect = { id: number; effect: Effect };

/**
 * M4_DESIGN §3.3 reduced motion: walks, parcels, merges (no confetti), paper and
 * the door show their result directly, which the view model already draws; the
 * envelope becomes a single flash of the destination nameplate; the printer shows
 * its last frame. Returns null when nothing is left to show.
 */
export function reduceEffect(effect: Effect): Effect | null {
  switch (effect.kind) {
    case 'envelope':
      return effect.reducedMotion;
    case 'flash-nameplate':
    case 'print':
      return effect;
    default:
      return null;
  }
}

export type QueueState = {
  playing: QueuedEffect[];
  waiting: QueuedEffect[];
  /** Highest id accepted so far; older or repeated ids are ignored. */
  lastId: number;
  skipped: number;
};

export const emptyQueue = (): QueueState => ({
  playing: [],
  waiting: [],
  lastId: -1,
  skipped: 0,
});

/** Accept new effects (by id) and start as many as the cap allows. */
export function enqueue(
  state: QueueState,
  incoming: readonly QueuedEffect[],
  reducedMotion: boolean,
): QueueState {
  let lastId = state.lastId;
  const fresh: QueuedEffect[] = [];
  for (const entry of incoming) {
    if (entry.id <= lastId) continue;
    lastId = entry.id;
    const effect = reducedMotion ? reduceEffect(entry.effect) : entry.effect;
    if (effect) fresh.push({ id: entry.id, effect });
  }
  if (fresh.length === 0 && lastId === state.lastId) return state;
  const filled = fill({
    ...state,
    waiting: [...state.waiting, ...fresh],
    lastId,
  });
  const kept = filled.waiting.slice(0, MAX_WAITING);
  return {
    ...filled,
    waiting: kept,
    skipped: state.skipped + filled.waiting.length - kept.length,
  };
}

/** An effect finished (or was cancelled): free its slot. */
export function finish(state: QueueState, id: number): QueueState {
  if (!state.playing.some((p) => p.id === id)) return state;
  return fill({
    ...state,
    playing: state.playing.filter((p) => p.id !== id),
  });
}

/** Reduced motion turned on: drop what has no reduced form. */
export function reduceAll(state: QueueState): QueueState {
  const keep = (list: QueuedEffect[]) =>
    list.flatMap((q) => {
      const effect = reduceEffect(q.effect);
      return effect ? [{ id: q.id, effect }] : [];
    });
  return fill({
    ...state,
    playing: keep(state.playing),
    waiting: keep(state.waiting),
  });
}

function fill(state: QueueState): QueueState {
  const free = MAX_PLAYING - state.playing.length;
  if (free <= 0 || state.waiting.length === 0) return state;
  return {
    ...state,
    playing: [...state.playing, ...state.waiting.slice(0, free)],
    waiting: state.waiting.slice(free),
  };
}
