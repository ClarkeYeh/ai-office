import type { GateDecisionRequest, GateView } from '@ai-office/contracts/api';
export type GateAction = Omit<GateDecisionRequest, 'expectedVersion'>;
export type WorkItemDraft = NonNullable<GateView['workItems']>[number];
export type GateOption = GateView['options'][number];

/** Advisory only: decide on the server remains authoritative. */
export function dependencyErrors(items: readonly WorkItemDraft[]): string[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const errors = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) {
      errors.add(key);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key)?.deps ?? []) {
      if (!byKey.has(dep)) errors.add(dep);
      else visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const item of items) visit(item.key);
  if (byKey.size !== items.length) errors.add('duplicate');
  return [...errors];
}
export function optionAction(
  option: GateOption,
  value: string,
): GateAction | null {
  const base: GateAction = { decision: 'option', optionId: option.optionId };
  if (option.input === 'tokens') {
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount > 0
      ? { ...base, additionalTokens: amount }
      : null;
  }
  if (option.input === 'agent')
    return value === 'codex' || value === 'claude-code'
      ? { ...base, agent: value }
      : null;
  if (option.input === 'text')
    return value.trim() ? { ...base, comment: value.trim() } : null;
  return base;
}
/** S26 remains optional until the M2 contracts converge. */
export function isRateLimited(value: object | undefined): boolean {
  return !!value && 'rateLimited' in value && value.rateLimited != null;
}
