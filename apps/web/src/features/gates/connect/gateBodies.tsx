import type { GateBodyProps } from './gateBodyTypes.js';
export type { GateBodyProps } from './gateBodyTypes.js';
import type { ComponentType } from 'react';
import type { GateView } from '../model/index.js';
import { OtherGatePage } from './OtherGatePage.js';
import { ConclusionGatePage } from './ConclusionGatePage.js';

/**
 * Gate kind → body. Extension point for M4-T11b (work items, final PR, exception
 * gates): add a branch here; the shell (`GatePage`, `GateLayout`) stays as is.
 */
export function gateBodyFor(gate: GateView): ComponentType<GateBodyProps> {
  if (gate.content.type === 'conclusion') return ConclusionGatePage;
  return OtherGatePage;
}
