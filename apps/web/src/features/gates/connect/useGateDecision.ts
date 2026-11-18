import { useCallback, useRef, useState } from 'react';
import {
  ApiError,
  createIdempotencyKey,
  type ApiBody,
  type ApiClient,
} from '../../../api/index.js';
import { useWebState } from '../../../realtime/index.js';
import { t, type MessageKey } from '../../../shared/lib/i18n/index.js';
import type { GateView } from '../model/index.js';

export type DecisionBody = Omit<ApiBody<'decideGate'>, 'expectedVersion'>;
export interface GateNoticeState {
  tone: 'info' | 'error';
  text: string;
}
export interface GateDecisionState {
  pending: boolean;
  notice: GateNoticeState | null;
  /** Increments on every 409; views use it to re-show what changed (diff). */
  conflicts: number;
  /** Resolves true when the server accepted the decision. */
  decide: (body: DecisionBody, success: MessageKey) => Promise<boolean>;
}

const CONFLICTS = new Set(['gate_content_changed', 'version_conflict']);

function errorNotice(error: ApiError): string {
  if (error.code === 'gate_content_changed')
    return t('gates.error.contentChanged');
  if (error.code === 'version_conflict')
    return t('gates.error.versionConflict');
  if (error.code === 'gate_not_open') return t('gates.error.notOpen');
  if (error.code === 'scm_unavailable') return t('gates.error.scm');
  if (error.status === 0 && error.category === 'transient')
    return t('gates.error.network');
  if (error.category === 'validation')
    return t('gates.error.validation', { code: error.code });
  return t('gates.error.generic', { code: error.code });
}

/**
 * Decision submission shared by every gate kind: `expectedVersion` from the gate on
 * screen, one Idempotency-Key per user action (kept for a resend of the same body,
 * replaced when the body or version changes), and 409 handling: refetch and ask again.
 */
export function useGateDecision(
  gate: GateView,
  api: ApiClient,
  refetch: () => void,
): GateDecisionState {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<GateNoticeState | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const action = useRef<{ fingerprint: string; key: string } | null>(null);
  const replaying = useWebState((state) => state.replay !== null);
  const { gateId, version } = gate;
  const decide = useCallback(
    async (body: DecisionBody, success: MessageKey) => {
      // Never decide from a historical state (T14 replay).
      if (replaying) return false;
      const request = { ...body, expectedVersion: version };
      const fingerprint = JSON.stringify([gateId, request]);
      const key =
        action.current?.fingerprint === fingerprint
          ? action.current.key
          : createIdempotencyKey();
      action.current = { fingerprint, key };
      setPending(true);
      setNotice(null);
      try {
        await api.decideGate(gateId, request, { idempotencyKey: key });
        action.current = null;
        setNotice({ tone: 'info', text: t(success) });
        refetch();
        return true;
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError(0, {
                code: 'network_error',
                category: 'transient',
                retryable: true,
                message: String(error),
              });
        setNotice({ tone: 'error', text: errorNotice(apiError) });
        // Keep the key only for an uncertain transport failure (a resend is the same action).
        if (apiError.status !== 0) action.current = null;
        if (CONFLICTS.has(apiError.code) || apiError.code === 'gate_not_open') {
          if (CONFLICTS.has(apiError.code)) setConflicts((n) => n + 1);
          refetch();
        }
        return false;
      } finally {
        setPending(false);
      }
    },
    [api, gateId, version, refetch, replaying],
  );
  return { pending, notice, conflicts, decide };
}
