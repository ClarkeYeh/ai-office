import { useCallback, useSyncExternalStore } from 'react';
import { useNavigation } from '../../../shared/ui/index.js';

const subscribe = (listener: () => void) => {
  globalThis.addEventListener('popstate', listener);
  return () => globalThis.removeEventListener('popstate', listener);
};
export function useSeatSelection() {
  const { navigate } = useNavigation();
  const search = useSyncExternalStore(
    subscribe,
    () => location.search,
    () => '',
  );
  const selectedSeatId = new URLSearchParams(search).get('seat');
  const selectSeat = useCallback(
    (seatId: string) => {
      const url = new URL(location.href);
      url.searchParams.set('seat', seatId);
      navigate(url.pathname + url.search, { replace: true });
    },
    [navigate],
  );
  return { selectedSeatId, selectSeat };
}
