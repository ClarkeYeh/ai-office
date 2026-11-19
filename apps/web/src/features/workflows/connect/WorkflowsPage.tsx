import { useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../../../api/index.js';
import { useWebState } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { workflowRows } from '../model/workflows.js';
import { WorkflowList } from '../ui/WorkflowList.js';

export function WorkflowsPage({ api }: { api: ApiClient }) {
  const workflows = useWebState((state) => state.overview.workflows);
  const rows = useMemo(() => workflowRows(workflows, t), [workflows]);
  const [confirmation, setConfirmation] = useState<{
    id: string;
    action: 'cancel' | 'cleanup';
  } | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [message, setMessage] = useState<'accepted' | 'failed' | null>(null);
  async function confirm() {
    if (!confirmation || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setMessage(null);
    try {
      if (confirmation.action === 'cancel')
        await api.cancelWorkflow(confirmation.id);
      else await api.cleanupWorkflow(confirmation.id);
      setMessage('accepted');
      setConfirmation(null);
    } catch {
      setMessage('failed');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <WorkflowList
      rows={rows}
      pending={pending}
      confirmation={confirmation}
      message={message}
      onRequest={(id, action) => {
        setMessage(null);
        setConfirmation({ id, action });
      }}
      onConfirm={() => {
        void confirm();
      }}
      onDismiss={() => setConfirmation(null)}
    />
  );
}
