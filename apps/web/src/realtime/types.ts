import type {
  GateView,
  HealthView,
  QuestionView,
  RepoView,
  WorkflowSummary,
} from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import type { ReadModel } from '@ai-office/projection';

export type ConnectionStatus =
  'connecting' | 'live' | 'reconnecting' | 'resyncing' | 'offline';

export interface Overview {
  workflows: WorkflowSummary[];
  gates: GateView[];
  questions: QuestionView[];
  health: HealthView | null;
  repos: RepoView[];
}

/** Server state only (M4_PLAN §3.3); view models are computed outside the store. */
export interface WebState {
  auth: 'unknown' | 'ok' | 'missing';
  connection: {
    status: ConnectionStatus;
    /** Highest global seq received from the stream. */
    cursor: number;
    /** Reconnect, resync or gap catch-up in progress: applied events are background. */
    catchingUp: boolean;
  };
  overview: Overview;
  active: {
    workflowId: string | null;
    live: ReadModel | null;
    status: 'idle' | 'loading' | 'ready' | 'missing';
  };
  replay: null | {
    workflowId: string;
    eventCount: number;
    /** Current position; 0 before the first event. */
    seq: number;
    model: ReadModel | null;
    loading: boolean;
    /** 0–1 while loading pages. */
    progress: number;
  };
}

/**
 * One event that changed the displayed read model. `background` events (catch-up,
 * stale `occurredAt`, hidden page) update state but must not animate (D4).
 */
export interface AppliedEvent {
  event: DomainEvent;
  prev: ReadModel | null;
  next: ReadModel | null;
  background: boolean;
}

/** `(prev, next) → next` reusing unchanged parts of `prev` (shared/lib `stabilize`). */
export type Stabilize = <T>(prev: T | undefined, next: T) => T;
