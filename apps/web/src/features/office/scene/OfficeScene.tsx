import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { OfficeViewModel, RoomId } from '../model/index.js';
import { EffectLayer } from './EffectLayer.js';
import { Eggs } from './Eggs.js';
import { Background, FloorProps, SkyPanes } from './Floor.js';
import { skyAt, ZOOM_FACTOR } from './geometry.js';
import type { SceneTranslate } from './messages.js';
import {
  emptyQueue,
  enqueue,
  finish,
  reduceAll,
  type QueuedEffect,
} from './player.js';
import { ARROWS, neighbour, rovingId } from './roving.js';
import {
  Inbox,
  ReservedButton,
  RoomPlate,
  SeatButton,
  WhiteboardButton,
  YourDeskButton,
  seatRect,
} from './Seats.js';
import { reservedPlateKey, seatPlateKey, suppressed } from './suppress.js';
import { useReducedMotion } from './useReducedMotion.js';
import css from './scene.module.css';

export type OfficeSceneProps = {
  vm: OfficeViewModel;
  /** Integer scale (`sceneScale`), at least 2; 1 only for the still gate thumbnail. */
  scale: number;
  /** The catalog translator, for the few strings the view model does not carry. */
  t: SceneTranslate;
  /** Effects in arrival order with increasing ids; background events never get here. */
  effects?: readonly QueuedEffect[];
  /** Cancels old animations on replay seeks/catch-up without moving the camera. */
  effectEpoch?: number;
  /** false: the gate page's still thumbnail (no buttons, no effects). */
  interactive?: boolean;
  /** Overrides `prefers-reduced-motion` (tests, harness). */
  reducedMotion?: boolean;
  onSelectSeat?: (seatId: string) => void;
  onSelectReserved?: (itemKey: string) => void;
  /** The whiteboard switches to the board (D2). */
  onOpenBoard?: () => void;
  /** Your desk: the gate inbox. */
  onOpenDesk?: () => void;
  /** An effect finished or was dropped; the caller may forget it. */
  onEffectDone?: (id: number) => void;
  /** Local clock for the sky and the clock easter egg. */
  now?: () => Date;
};

const NO_EFFECTS: readonly QueuedEffect[] = [];
const systemNow = () => new Date();

/**
 * The pixel office (M4_PLAN §3.6): background strips, state sprites, people as
 * buttons with DOM nameplates, the effect player, room zoom, the stage-gate
 * hush and the easter eggs. It only reads the view model, effects and callbacks.
 */
export const OfficeScene = memo(function OfficeScene({
  vm,
  scale: s,
  t,
  effects = NO_EFFECTS,
  effectEpoch = 0,
  interactive = true,
  reducedMotion: reducedOverride,
  onSelectSeat,
  onSelectReserved,
  onOpenBoard,
  onOpenDesk,
  onEffectDone,
  now = systemNow,
}: OfficeSceneProps) {
  const reducedMotion = useReducedMotion(reducedOverride);
  const W = vm.world.width * s;
  const H = vm.world.height * s;

  // -- effect queue ----------------------------------------------------------
  const [queue, setQueue] = useState(emptyQueue);
  useEffect(() => {
    setQueue(emptyQueue());
  }, [effectEpoch]);
  useEffect(() => {
    if (!interactive) return;
    setQueue((q) => enqueue(q, effects, reducedMotion));
  }, [effects, reducedMotion, interactive, effectEpoch]);
  useEffect(() => {
    if (reducedMotion) setQueue(reduceAll);
  }, [reducedMotion]);
  const onDone = useCallback(
    (id: number) => {
      setQueue((q) => finish(q, id));
      onEffectDone?.(id);
    },
    [onEffectDone],
  );
  const hidden = useMemo(() => suppressed(vm, queue.playing), [vm, queue]);

  // -- zoom (D13) and the sky (§3.4) ------------------------------------------
  const [zoom, setZoom] = useState<RoomId | null>(null);
  const toggleZoom = useCallback(
    (id: RoomId) => setZoom((z) => (z === id ? null : id)),
    [],
  );
  const [sky, setSky] = useState(() => skyAt(now().getHours()));
  const onClock = useCallback(() => setSky(skyAt(now().getHours())), [now]);
  const zoomRoom = vm.rooms.find((r) => r.id === zoom);
  const transform = useMemo(() => {
    if (!zoomRoom) return undefined;
    const clamp = (v: number, min: number) =>
      Math.round(Math.min(0, Math.max(min, v)));
    const { x, y, w, h } = zoomRoom.rect;
    const tx = clamp(
      W / 2 - (x + w / 2) * s * ZOOM_FACTOR,
      W - W * ZOOM_FACTOR,
    );
    const ty = clamp(
      H / 2 - (y + h / 2) * s * ZOOM_FACTOR,
      H - H * ZOOM_FACTOR,
    );
    return `translate(${tx}px, ${ty}px) scale(${ZOOM_FACTOR})`;
  }, [zoomRoom, W, H, s]);

  // -- roving tabindex over seats (§5.4) --------------------------------------
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const register = useCallback(
    (seatId: string, button: HTMLButtonElement | null) => {
      if (button) buttons.current.set(seatId, button);
      else buttons.current.delete(seatId);
    },
    [],
  );
  const [remembered, setRemembered] = useState<string | null>(null);
  const visibleSeats = useMemo(
    () =>
      vm.seats.filter(
        (seat) => seat.place !== 'meeting' || seat.pose !== 'away',
      ),
    [vm.seats],
  );
  const seatIds = visibleSeats.map((seat) => seat.seatId);
  const tabbable = rovingId(
    seatIds,
    remembered,
    vm.seats.find((seat) => seat.selected)?.seatId,
  );
  const points = useMemo(
    () =>
      visibleSeats.map((seat) => {
        const r = seatRect(seat);
        return { id: seat.seatId, x: r.x + r.w / 2, y: r.y + r.h / 2 };
      }),
    [visibleSeats],
  );
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const onSeatKey = useCallback(
    (seatId: string, event: KeyboardEvent<HTMLButtonElement>) => {
      const points = pointsRef.current;
      let target: string | undefined;
      const direction = ARROWS[event.key];
      if (direction) target = neighbour(points, seatId, direction);
      else if (event.key === 'Home') target = points[0]?.id;
      else if (event.key === 'End') target = points.at(-1)?.id;
      else return;
      event.preventDefault();
      if (target === undefined) return;
      setRemembered(target);
      buttons.current.get(target)?.focus();
    },
    [],
  );
  const onRootKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && zoom !== null) {
      event.stopPropagation();
      setZoom(null);
    }
  };

  // Figures lower on the floor are drawn later (in front).
  const byDepth = useMemo(
    () => [...visibleSeats].sort((a, b) => a.y - b.y),
    [visibleSeats],
  );
  const lit = vm.hush.lit;
  return (
    <div
      className={css.frame}
      style={{ width: W, height: H }}
      data-testid="office-scene"
      data-scale={s}
      data-reduced={reducedMotion ? 'true' : 'false'}
      data-zoom={zoom ?? undefined}
      data-still={interactive ? undefined : 'true'}
      {...(interactive
        ? { role: 'group', 'aria-label': t('office.scene.aria') }
        : { 'aria-hidden': true })}
      onKeyDown={interactive ? onRootKey : undefined}
    >
      <div className={css.world} style={{ width: W, height: H, transform }}>
        <Background rows={vm.world.rows} scale={s} />
        <SkyPanes sky={sky} scale={s} />
        <FloorProps vm={vm} scale={s} hidden={hidden} />
        {vm.rooms.map((room) => (
          <RoomPlate
            key={room.id}
            room={room}
            scale={s}
            interactive={interactive}
            zoomed={zoom === room.id}
            zoomOutLabel={t('office.scene.zoomOut', { room: room.label })}
            onToggle={toggleZoom}
          />
        ))}
        <Eggs
          rows={vm.world.rows}
          scale={s}
          interactive={interactive}
          reducedMotion={reducedMotion}
          t={t}
          onClock={onClock}
          now={now}
        />
        {vm.reserved.map((reserved) => (
          <ReservedButton
            key={reserved.itemKey}
            reserved={reserved}
            scale={s}
            interactive={interactive}
            flash={hidden.flash.has(reservedPlateKey(reserved.itemKey))}
            onSelect={onSelectReserved}
          />
        ))}
        {byDepth.map((seat) => (
          <SeatButton
            key={seat.seatId}
            seat={seat}
            scale={s}
            interactive={interactive}
            reducedMotion={reducedMotion}
            tabbable={seat.seatId === tabbable}
            walking={hidden.seats.has(seat.seatId)}
            flash={hidden.flash.has(seatPlateKey(seat.seatId))}
            onSelect={onSelectSeat}
            onKeyDown={onSeatKey}
            register={register}
          />
        ))}
        <WhiteboardButton
          board={vm.whiteboard}
          scale={s}
          interactive={interactive}
          onOpen={onOpenBoard}
        />
        <Inbox
          inbox={vm.inbox}
          scale={s}
          interactive={interactive}
          flash={hidden.flash.has('inbox')}
        />
        <YourDeskButton
          desk={vm.yourDesk}
          scale={s}
          interactive={interactive}
          reducedMotion={reducedMotion}
          flash={hidden.flash.has('your-desk')}
          onOpen={onOpenDesk}
        />
        {interactive ? (
          <EffectLayer
            playing={queue.playing}
            vm={vm}
            scale={s}
            reducedMotion={reducedMotion}
            onDone={onDone}
          />
        ) : null}
        {vm.hush.active ? (
          <div
            className={css.hush}
            data-testid="office-hush"
            aria-hidden="true"
            style={{
              clipPath: `path(evenodd, 'M0 0H${W}V${H}H0Z M${lit.x * s} ${lit.y * s}H${(lit.x + lit.w) * s}V${(lit.y + lit.h) * s}H${lit.x * s}Z')`,
            }}
          />
        ) : null}
      </div>
      {vm.hush.active ? (
        <span className={css.srOnly}>{vm.hush.label}</span>
      ) : null}
    </div>
  );
});
