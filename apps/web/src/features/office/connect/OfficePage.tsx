import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { t } from '../../../shared/lib/i18n/index.js';
import { useNavigation } from '../../../shared/ui/index.js';
import { OfficeScene, sceneScale } from '../scene/index.js';
import { Board } from '../ui/Board.js';
import { useOfficeViewModel, useBoardViewModel } from './useOfficeViewModel.js';
import { useOfficeEffects } from './useOfficeEffects.js';
import { useSeatSelection } from './selection.js';
import css from '../ui/office.module.css';

export function OfficePage({ timeline }: { timeline?: ReactNode }) {
  const { selectedSeatId, selectSeat } = useSeatSelection();
  const vm = useOfficeViewModel(selectedSeatId);
  const { queue, generation, onEffectDone } = useOfficeEffects(vm?.workflowId);
  const { navigate } = useNavigation();
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(2);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => setScale(sceneScale(element.clientWidth));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [vm?.workflowId]);
  const workflowId = vm?.workflowId;
  const openBoard = useCallback(() => {
    if (workflowId)
      navigate(
        `/workflows/${encodeURIComponent(workflowId)}/board${location.search}`,
      );
  }, [navigate, workflowId]);
  const openDesk = useCallback(
    () => document.getElementById('needs-you')?.focus(),
    [],
  );
  return (
    <div ref={host} className={css.viewport} data-testid="office-page">
      {vm ? (
        <OfficeScene
          key={vm.workflowId}
          effectEpoch={generation}
          vm={vm}
          t={t}
          scale={scale}
          effects={queue}
          onEffectDone={onEffectDone}
          onSelectSeat={selectSeat}
          onSelectReserved={openBoard}
          onOpenBoard={openBoard}
          onOpenDesk={openDesk}
        />
      ) : (
        <p role="status">{t('app.loading')}</p>
      )}
      <div data-testid="office-timeline-slot">{timeline}</div>
    </div>
  );
}
export function OfficeBoardPage() {
  const { selectedSeatId, selectSeat } = useSeatSelection();
  const vm = useBoardViewModel(selectedSeatId);
  return vm ? (
    <Board vm={vm} onSelectSeat={selectSeat} />
  ) : (
    <p role="status">{t('app.loading')}</p>
  );
}
