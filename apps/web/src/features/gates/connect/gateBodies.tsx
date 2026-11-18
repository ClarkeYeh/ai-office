import type { ComponentType } from 'react';
import { t } from '../../../shared/lib/i18n/index.js';
import type { GateView } from '../model/index.js';
import { GateLayout } from '../ui/index.js';
import { ConclusionGatePage } from './ConclusionGatePage.js';
import type { GateBodyProps } from './types.js';

export type { GateBodyProps } from './types.js';

function PendingGateBody({ layout }: GateBodyProps) {
  return (
    <GateLayout {...layout}>
      <p data-testid="gate-body-pending">{t('gates.pending')}</p>
    </GateLayout>
  );
}

/**
 * Gate kind → body. Extension point for M4-T11b (work items, final PR, exception
 * gates): add a branch here; the shell (`GatePage`, `GateLayout`) stays as is.
 */
export function gateBodyFor(gate: GateView): ComponentType<GateBodyProps> {
  if (gate.content.type === 'conclusion') return ConclusionGatePage;
  return PendingGateBody;
}
