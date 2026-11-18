import type { ReadModel } from './model.js';

// G4 (§22.4): the read-side mirror of the domain's dispatch readiness rule (§7.3).
// The domain keeps its own copy (it may not depend on projection); both are
// checked against the same case table in readiness.test.ts.

/** Transitive dependency keys in breadth-first discovery order; cycle-safe. */
function dependenciesOf(model: ReadModel, itemKey: string): string[] {
  const deps = (key: string) =>
    model.workItems.find((w) => w.key === key)?.deps ?? [];
  const seen = new Set<string>();
  const pending = [...deps(itemKey)];
  for (let i = 0; i < pending.length; i++) {
    const dep = pending[i]!;
    if (seen.has(dep)) continue;
    seen.add(dep);
    pending.push(...deps(dep));
  }
  return [...seen];
}

/** A `dependency-blocked` gate answered with `proceed` waives skipped or failed deps. */
function dependencyOverride(model: ReadModel, itemKey: string): boolean {
  return model.gates.some(
    (g) =>
      g.kind === 'exception' &&
      g.exceptionKind === 'dependency-blocked' &&
      g.content.type === 'exception' &&
      g.content.itemKey === itemKey &&
      g.decision?.optionId === 'proceed',
  );
}

/**
 * Transitive dependencies of `itemKey` that still block dispatch: every dependency
 * that is not `merged`, unless waived by a dependency override. Unknown keys fail
 * closed (they stay in the list).
 */
export function blockedByOf(model: ReadModel, itemKey: string): string[] {
  const waived = dependencyOverride(model, itemKey);
  return dependenciesOf(model, itemKey).filter((dep) => {
    const status = model.workItems.find((w) => w.key === dep)?.status;
    if (status === 'merged') return false;
    return !(waived && (status === 'skipped' || status === 'failed'));
  });
}

/** True when the work item exists and no dependency blocks it (status is not checked). */
export function isReady(model: ReadModel, itemKey: string): boolean {
  return (
    model.workItems.some((w) => w.key === itemKey) &&
    blockedByOf(model, itemKey).length === 0
  );
}
