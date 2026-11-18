import { useSyncExternalStore, type ReactNode } from 'react';
import { t } from '../../../shared/lib/i18n/index.js';
import { PixelFrame } from '../../../shared/ui/index.js';
import type { OfficeSeat } from '../model/index.js';
import { Avatar } from '../scene/index.js';
import { useOfficeViewModel } from './useOfficeViewModel.js';
import { useSeatSelection } from './selection.js';

const query = '(max-width: 899px)';
const subscribe = (listener: () => void) => {
  const media = matchMedia(query);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};
/** T10 supplies its connected inspector through this slot; it handles empty and missing seats. */
export function OfficeRightColumn({
  inspector,
}: {
  inspector?: (seatId: string | null) => ReactNode;
}) {
  const mobile = useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => true,
  );
  const { selectedSeatId } = useSeatSelection();
  const vm = useOfficeViewModel(selectedSeatId);
  const seat: OfficeSeat | undefined = vm?.seats.find(
    (s) => s.seatId === selectedSeatId,
  );
  if (mobile) return null;
  return (
    <div data-testid="office-inspector-slot">
      {inspector ? (
        inspector(selectedSeatId)
      ) : (
        <PixelFrame data-testid="office-seat-summary">
          <h2>{t('office.page.inspector')}</h2>
          {seat ? (
            <>
              <Avatar seat={seat} />
              <h3>{seat.nameplate.title}</h3>
              <p>{seat.nameplate.subtitle}</p>
            </>
          ) : (
            <p>{t('office.page.selectSeat')}</p>
          )}
        </PixelFrame>
      )}
    </div>
  );
}
