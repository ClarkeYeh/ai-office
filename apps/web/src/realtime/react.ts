// The only realtime file allowed to import React: store → hooks bridge (M4_PLAN §3.3).
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import type { ReadModel } from '@ai-office/projection';
import type { AppliedListener } from './bus.js';
import type { Realtime } from './realtime.js';
import { selectDisplayedModel } from './store.js';
import type { Stabilize, WebState } from './types.js';

const RealtimeContext = createContext<Realtime | null>(null);

export function RealtimeProvider(props: {
  realtime: Realtime;
  children?: ReactNode;
}) {
  return createElement(
    RealtimeContext.Provider,
    { value: props.realtime },
    props.children,
  );
}

export function useRealtime(): Realtime {
  const realtime = useContext(RealtimeContext);
  if (!realtime) throw new Error('useRealtime requires <RealtimeProvider>');
  return realtime;
}

/** Selectors must return stable references (no new objects per call). */
export function useWebState<T>(selector: (state: WebState) => T): T {
  return useStore(useRealtime().store, selector);
}

export function useDisplayedModel(): ReadModel | null {
  return useWebState(selectDisplayedModel);
}

const identity: Stabilize = (_prev, next) => next;

/**
 * VM computed outside the store selector (React 19 snapshot stability):
 * `selector(displayedModel, args)` reruns only when the model, the selector, or a
 * shallow value of `args` changes; `stabilize` keeps unchanged sub-trees identical.
 * Pass a module-level selector; an inline one recomputes on every render.
 */
export function useViewModel<A extends object, V>(
  selector: (model: ReadModel | null, args: A) => V,
  args: A,
  stabilize: Stabilize = identity,
): V {
  const model = useDisplayedModel();
  const stableArgs = useShallowStable(args);
  const prev = useRef<V | undefined>(undefined);
  return useMemo(() => {
    const next = stabilize(prev.current, selector(model, stableArgs));
    prev.current = next;
    return next;
  }, [model, stableArgs, selector, stabilize]);
}

/** Wall-clock `now` (ms) from the global 30-second ticker. */
export function useNow(): number {
  const { ticker } = useRealtime();
  return useSyncExternalStore(ticker.subscribe, ticker.now, ticker.now);
}

/** Subscribe to the AppliedEvent bus for the component's lifetime. */
export function useAppliedEvents(listener: AppliedListener): void {
  const { bus } = useRealtime();
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => bus.subscribe((applied) => latest.current(applied)), [bus]);
}

function useShallowStable<A extends object>(value: A): A {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) ref.current = value;
  return ref.current;
}

export function shallowEqual(a: object, b: object): boolean {
  if (Object.is(a, b)) return true;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}
