import type { ApiClient } from '../../../api/index.js';
import type { GateView, WorkflowModel } from '../model/index.js';
import type { GateLayoutProps } from '../ui/index.js';

/** What the shell hands every gate body; the body renders `GateLayout` with `layout`. */
export interface GateBodyProps {
  gate: GateView;
  /** The gate's workflow read model, or null when another workflow is active. */
  model: WorkflowModel | null;
  api: ApiClient;
  refetch: () => void;
  layout: Omit<GateLayoutProps, 'children' | 'decision'>;
}
