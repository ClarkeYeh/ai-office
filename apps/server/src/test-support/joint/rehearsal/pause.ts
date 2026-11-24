/**
 * M5-T11 exact pause points (M5_PLAN §2.4), on the harness side of the SCM
 * bridge. The real call runs to completion; when it succeeded inside an armed
 * window, its reply to the backend child is withheld forever, so the child is
 * stopped after the external effect and before `command.succeeded`:
 * - P1: the first `createIssue` that succeeded;
 * - P2: after P1, the first `mergePR` (its `POST /merges` succeeded) of a PR
 *   the driver identifies as `mul` or `sub` (the K item keys, §2.3.2).
 * Each window fires at most once and P2 only after P1. Failed calls are never
 * withheld. Pure apart from the wrapped target, so CI pins it directly.
 */
import type { RehearsalWindow } from './protocol.js';

export interface PauseHit {
  window: RehearsalWindow;
  method: 'createIssue' | 'mergePR';
  /** createIssue: the engine commandId from the correlation (unscoped). */
  commandId?: string;
  /** mergePR: the PR number. */
  pr?: number;
  /** mergePR: the merge commit GitHub returned. */
  mergeCommitSha?: string;
  /** mergePR: the PR head it merged (the merge commit's second parent). */
  headSha?: string;
}

export class PauseGate {
  /** In firing order; the driver kills once per new entry. */
  readonly hits: PauseHit[] = [];

  constructor(
    private readonly options: {
      /** True when the merged PR is a K item (`mul` / `sub`). */
      isWindowPr(pr: number): Promise<boolean>;
    },
  ) {}

  fired(window: RehearsalWindow): boolean {
    return this.hits.some((h) => h.window === window);
  }

  private hit(hit: PauseHit): Promise<never> {
    this.hits.push(hit);
    // Never settles: the bridge never answers the child for this call.
    return new Promise<never>(() => undefined);
  }

  /** The served SCM with the two windows applied. */
  wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (object, property) => {
        const value = Reflect.get(object, property, object) as unknown;
        if (typeof value !== 'function') return value;
        const fn = (value as (...a: unknown[]) => unknown).bind(object);
        if (property === 'createIssue')
          return async (...args: unknown[]) => {
            const result = await fn(...args);
            if (this.fired('P1')) return result;
            const commandId = (args[2] as { commandId?: unknown } | undefined)
              ?.commandId;
            return this.hit({
              window: 'P1',
              method: 'createIssue',
              ...(typeof commandId === 'string' ? { commandId } : {}),
            });
          };
        if (property === 'mergePR')
          return async (...args: unknown[]) => {
            const result = (await fn(...args)) as { mergeCommitSha: string };
            const pr = (args[0] as { number?: unknown } | undefined)?.number;
            const head = (args[1] as { expectedHeadSha?: unknown } | undefined)
              ?.expectedHeadSha;
            if (
              !this.fired('P1') ||
              this.fired('P2') ||
              typeof pr !== 'number' ||
              !(await this.options.isWindowPr(pr))
            )
              return result;
            return this.hit({
              window: 'P2',
              method: 'mergePR',
              pr,
              mergeCommitSha: result.mergeCommitSha,
              ...(typeof head === 'string' ? { headSha: head } : {}),
            });
          };
        return fn;
      },
    });
  }
}
