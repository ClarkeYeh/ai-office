import { OfficeScene, useOfficeViewModel } from '../../office/index.js';
import { t } from '../../../shared/lib/i18n/index.js';

/**
 * V3Gate's quiet office: the real scene at an integer 1× (pixel-crisp), still
 * and hidden from assistive tech; `GateLayout` gives the slot its text
 * alternative. Only the gate's own workflow is drawn.
 */
export function GateThumbnail({ workflowId }: { workflowId: string }) {
  const vm = useOfficeViewModel();
  if (!vm || vm.workflowId !== workflowId) return null;
  return <OfficeScene vm={vm} t={t} scale={1} interactive={false} />;
}
