import { useMemo } from 'react';
import type { ApiClient } from '../../../api/index.js';
import {
  useDisplayedModel,
  useNow,
  useWebState,
} from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { gateHeaderViewModel } from '../model/index.js';
import { GateNotice, GateStatusMessage } from '../ui/index.js';
import { gateBodyFor } from './gateBodies.js';
import { useGate } from './useGate.js';

export interface GatePageProps {
  route: { params: Readonly<Record<string, string>> };
  api: ApiClient;
}

/** `/gates/:id`: full-page gate (D6). Loads the gate, then hands off by kind. */
export function GatePage({ route, api }: GatePageProps) {
  const gateId = route.params.id ?? '';
  const load = useGate(gateId, api);
  const displayed = useDisplayedModel();
  const now = useNow();
  const replaying = useWebState((state) => state.replay !== null);
  const gate = load.gate;
  const model =
    gate && displayed?.workflowId === gate.workflowId ? displayed : null;
  const header = useMemo(
    () => (gate ? gateHeaderViewModel(gate, model, { now, t }) : null),
    [gate, model, now],
  );
  if (!gate || !header)
    return (
      <GateStatusMessage
        message={
          load.status === 'missing'
            ? t('gates.notFound')
            : load.status === 'error'
              ? t('gates.loadFailed')
              : t('gates.loading')
        }
      />
    );
  const Body = gateBodyFor(gate);
  return (
    <Body
      key={gate.gateId}
      gate={gate}
      model={model}
      api={api}
      refetch={load.refetch}
      layout={{
        header,
        backHref: `/workflows/${encodeURIComponent(gate.workflowId)}`,
        readOnly: replaying,
        ...(load.status === 'error'
          ? {
              notice: (
                <GateNotice tone="error">{t('gates.loadFailed')}</GateNotice>
              ),
            }
          : {}),
      }}
    />
  );
}
