import { useMemo } from 'react';
import { ApiError, createApiClient } from '../../../api/index.js';
import {
  useDisplayedModel,
  useNow,
  useRealtime,
  useViewModel,
  useWebState,
} from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { seatsT } from '../../../shared/lib/i18n/seats.js';
import { PixelFrame } from '../../../shared/ui/index.js';
import { Avatar, officeViewModel } from '../../office/index.js';
import { messageDisabled, seatInspector } from '../model/seatInspector.js';
import {
  SeatInspectorPanel,
  type SendResult,
} from '../ui/SeatInspectorPanel.js';
import { useReviewHistory } from './history.js';

export function messageError(error: unknown): string {
  if (!(error instanceof ApiError)) return seatsT('seats.error.unknown');
  if (error.status === 401 || error.category === 'auth')
    return seatsT('seats.error.auth');
  if (error.status === 404 || error.status === 409)
    return seatsT('seats.error.conflict');
  if (error.status === 422 || error.category === 'validation')
    return seatsT('seats.error.validation');
  if (error.status === 429 || error.category === 'rate_limited')
    return seatsT('seats.error.rateLimited');
  if (error.status === 0 || error.retryable || error.status >= 500)
    return seatsT('seats.error.unknown');
  return seatsT('seats.error.failed');
}

/** Mount in the office inspector slot under the existing RealtimeProvider. */
export function SeatInspector({ seatId }: { seatId: string | null }) {
  const realtime = useRealtime();
  const model = useDisplayedModel();
  const now = useNow();
  const replaying = useWebState((s) => s.replay !== null);
  const api = useMemo(
    () =>
      createApiClient({
        onUnauthorized: () => {
          realtime.stop();
          realtime.store.setState({ auth: 'missing' });
        },
      }),
    [realtime],
  );
  const history = useReviewHistory(model?.workflowId ?? null, api);
  const vm = useViewModel(seatInspector, {
    seatId,
    now,
    replaying,
    events: history.events,
    t: seatsT,
  });
  const office = useMemo(
    () =>
      model ? officeViewModel(model, { now, t, selectedSeatId: seatId }) : null,
    [model, now, seatId],
  );
  const portrait = office?.seats.find((s) => s.seatId === seatId);
  if (!vm)
    return (
      <PixelFrame
        data-testid="seat-inspector-empty"
        aria-label={seatsT('seats.title')}
      >
        <p>{seatsT(seatId ? 'seats.missing' : 'seats.select')}</p>
      </PixelFrame>
    );
  async function send(body: string): Promise<SendResult> {
    // Re-check the live store at submission time, including a replay loading with no model.
    const state = realtime.store.getState();
    const live = state.active.live;
    const seat = live?.seats.find((s) => s.seatId === seatId);
    if (
      !live ||
      !seat ||
      live.workflowId !== vm!.workflowId ||
      seat.currentAttemptId !== vm!.attemptId
    )
      return { ok: false, message: seatsT('seats.error.conflict') };
    const disabled = messageDisabled(live, seat, state.replay !== null, seatsT);
    if (disabled) return { ok: false, message: disabled };
    try {
      await api.messageSeat(seat.seatId, body);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageError(error) };
    }
  }
  return (
    <SeatInspectorPanel
      key={`${vm.workflowId}:${vm.seatId}:${vm.attemptId}`}
      vm={vm}
      renderPortrait={() => (
        <Avatar
          seat={
            portrait ?? {
              role: vm.role,
              vendor: vm.agent,
              accessory: 'default',
            }
          }
          label={vm.role}
        />
      )}
      onSend={send}
      historyState={history.state}
      onRetryHistory={history.retry}
    />
  );
}
