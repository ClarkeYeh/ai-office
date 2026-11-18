import { useCallback, useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../../../api/index.js';
import { selectDisplayedModel, useWebState } from '../../../realtime/index.js';
import type { GateView } from '../model/index.js';

export type GateLoad =
  | { status: 'loading'; gate: null }
  | { status: 'missing'; gate: null }
  | { status: 'error'; gate: GateView | null }
  | { status: 'ready'; gate: GateView };

/**
 * `GET /gates/:id` (request-time `githubBody`/`renderedBody` live only here, not in
 * the read model). Refetches whenever the gate's version or status changes in the
 * live model or the overview inbox, and on `refetch()` (after a decision or a 409).
 */
export function useGate(
  gateId: string,
  api: ApiClient,
): GateLoad & { refetch: () => void } {
  const [load, setLoad] = useState<GateLoad & { gateId: string | null }>({
    gateId: null,
    status: 'loading',
    gate: null,
  });
  const [nonce, setNonce] = useState(0);
  // A primitive keeps the store snapshot stable.
  const signal = useWebState((state) => {
    const gate =
      selectDisplayedModel(state)?.gates.find((g) => g.gateId === gateId) ??
      state.overview.gates.find((g) => g.gateId === gateId);
    return gate ? `${gate.version}:${gate.status}` : '';
  });
  useEffect(() => {
    const controller = new AbortController();
    api.getGate(gateId, { signal: controller.signal }).then(
      (gate) => setLoad({ gateId, status: 'ready', gate }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad((prev) =>
          error instanceof ApiError && error.status === 404
            ? { gateId, status: 'missing', gate: null }
            : {
                gateId,
                status: 'error',
                gate: prev.gateId === gateId ? prev.gate : null,
              },
        );
      },
    );
    return () => controller.abort();
  }, [api, gateId, signal, nonce]);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  if (load.gateId !== gateId) return { status: 'loading', gate: null, refetch };
  return { ...load, refetch };
}
