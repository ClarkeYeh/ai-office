import type { ComponentType } from 'react';
import type { ReadModel } from '@ai-office/projection';
import type { ApiClient } from '../../../api/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import type { GateView } from '../model/index.js';
import { GateLayout, type GateLayoutProps } from '../ui/index.js';
import { ConclusionGatePage } from './ConclusionGatePage.js';

/** What the shell hands every gate body; the body renders `GateLayout` with `layout`. */
export interface GateBodyProps {
  gate: GateView;
  /** The gate's workflow read model, or null when another workflow is active. */
  model: ReadModel | null;
  api: ApiClient;
  refetch: () => void;
  layout: Omit<GateLayoutProps, 'children' | 'decision'>;
}

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
