import type { EventType } from '@ai-office/contracts/events';
import type { ApiClient } from '../api/index.js';
import type { WebStore } from './store.js';
import type { Overview } from './types.js';

export type OverviewPart = keyof Overview;
export type OverviewApi = Pick<
  ApiClient,
  'listWorkflows' | 'listGates' | 'listQuestions' | 'getHealth' | 'listRepos'
>;

export const OVERVIEW_DEBOUNCE_MS = 250;
const PARTS: readonly OverviewPart[] = [
  'workflows',
  'gates',
  'questions',
  'health',
  'repos',
];

/**
 * Which overview endpoints an event invalidates (M4_PLAN §3.4). Overview is refetched,
 * never folded in the browser, so a duplicate signal only causes an idempotent refetch.
 */
export function overviewPartsFor(type: EventType): OverviewPart[] {
  if (type.startsWith('gate.')) return ['gates', 'workflows'];
  if (type === 'message.escalated' || type === 'message.answered')
    return ['questions', 'workflows'];
  // A successful hijack reclaim restores run ownership and ends in a resume.
  if (type === 'workflow.paused' || type === 'workflow.resumed')
    return ['workflows', 'health'];
  if (
    type.startsWith('workflow.') ||
    type.startsWith('stage.') ||
    type === 'usage.tokens'
  )
    return ['workflows'];
  if (type === 'health.changed' || type.startsWith('runtime.identity_'))
    return ['health'];
  if (type.startsWith('repo.')) return ['repos'];
  return [];
}

export interface OverviewRefresher {
  /** Debounced (250 ms) refetch of the parts invalidated by `type`. */
  signal(type: EventType): void;
  /** Immediate refetch of every part. */
  refreshAll(): Promise<void>;
  dispose(): void;
}

export function createOverviewRefresher(options: {
  api: OverviewApi;
  store: WebStore;
  onError: (error: unknown) => void;
  debounceMs?: number;
}): OverviewRefresher {
  const { api, store } = options;
  const debounceMs = options.debounceMs ?? OVERVIEW_DEBOUNCE_MS;
  const timers = new Map<OverviewPart, ReturnType<typeof setTimeout>>();
  const requested: Record<OverviewPart, number> = {
    workflows: 0,
    gates: 0,
    questions: 0,
    health: 0,
    repos: 0,
  };
  const applied = { ...requested };
  let disposed = false;

  async function load<P extends OverviewPart>(part: P): Promise<Overview[P]> {
    switch (part) {
      case 'workflows':
        return (await api.listWorkflows()).workflows as Overview[P];
      case 'gates':
        return (await api.listGates({ status: 'open' })).gates as Overview[P];
      case 'questions':
        return (await api.listQuestions({ status: 'escalated' }))
          .questions as Overview[P];
      case 'health':
        return (await api.getHealth()) as Overview[P];
      default:
        return (await api.listRepos()).repos as Overview[P];
    }
  }

  async function refresh(part: OverviewPart): Promise<void> {
    const id = ++requested[part];
    try {
      const value = await load(part);
      // Responses can resolve out of order: never overwrite a newer one.
      if (disposed || id < applied[part]) return;
      applied[part] = id;
      store.setState((state) => ({
        auth: 'ok',
        overview: { ...state.overview, [part]: value },
      }));
    } catch (error) {
      if (!disposed) options.onError(error);
    }
  }

  return {
    signal(type) {
      for (const part of overviewPartsFor(type)) {
        // Not reset by later signals: a busy stream cannot starve the refetch.
        if (disposed || timers.has(part)) continue;
        timers.set(
          part,
          setTimeout(() => {
            timers.delete(part);
            void refresh(part);
          }, debounceMs),
        );
      }
    },
    async refreshAll() {
      await Promise.all(PARTS.map((part) => refresh(part)));
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
