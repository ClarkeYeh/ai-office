import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useRealtime, useWebState } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { messagesAt, positionAt, timelineModel } from '../model/timeline.js';
import { Timeline } from '../ui/Timeline.js';

/** Replay lifetime belongs to realtime; navigation within this workflow preserves it. */
export function TimelinePage({
  route,
}: {
  route: { params: Readonly<Record<string, string>> };
}) {
  const { replay: controller } = useRealtime();
  const replay = useWebState((state) => state.replay);
  const events = useSyncExternalStore(
    controller.subscribeEvents,
    controller.getEvents,
    controller.getEvents,
  );
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [route.params.id],
  );
  const model = useMemo(() => timelineModel(events, t), [events]);
  const seq = replay?.seq ?? 0;
  const index = positionAt(model.points, seq);
  const messages = useMemo(
    () => messagesAt(model.messages, seq),
    [model.messages, seq],
  );
  const pending = replay !== null && replay.model?.lastSeq !== replay.seq;
  async function open() {
    const current = ++request.current;
    setFailed(false);
    try {
      await controller.open(route.params.id!);
    } catch {
      if (current === request.current) setFailed(true);
    }
  }
  return (
    <Timeline
      model={model}
      index={index}
      messages={messages}
      replaying={replay !== null}
      loading={replay?.loading ?? false}
      progress={replay?.progress ?? 0}
      pending={pending}
      failed={failed}
      onOpen={() => {
        void open();
      }}
      onExit={() => {
        request.current++;
        setFailed(false);
        controller.exit();
      }}
      onSeek={(target) => {
        const point = model.points[target];
        if (point) controller.seek(point.seq);
      }}
      onStep={() => {
        controller.step();
      }}
    />
  );
}
