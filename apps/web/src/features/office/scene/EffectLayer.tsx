import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import type { Effect, OfficeViewModel, Point } from '../model/index.js';
import { placements } from './atlas.js';
import {
  characterSprite,
  envelopeDuration,
  resolveAnchor,
  seatOfAnchor,
  steppedPoints,
  walkPath,
  walkSteps,
  WALK_FPS,
} from './geometry.js';
import type { QueuedEffect } from './player.js';
import { animateSteps } from './motion.js';
import { Sprite } from './Sprite.js';
import css from './scene.module.css';

// Plays the effects the queue has started (player.ts). Motion is Web Animations
// with integer world steps × scale and `step-end` easing, so sprites never sit
// between pixels; completion is a plain timer so it does not depend on WAAPI.

type Done = (id: number) => void;
type Props<K extends Effect['kind']> = {
  id: number;
  effect: Extract<Effect, { kind: K }>;
  vm: OfficeViewModel;
  scale: number;
  reducedMotion: boolean;
  onDone: Done;
};

const FLASH_MS = 600;
const PRINT_MS = 1200;
const PRINT_FRAMES_MS = 375;
const CONFETTI_MS = 800;
const DOOR_CLOSED_MS = 300;
const PAPER_STEP_MS = 125;
const PARCEL_SPEED = 72; // world px per second
const MOVE_FPS = 16;
const WALK_CYCLE = { duration: 500, iterations: 'infinite' } as const;

/** Calls `onDone(id)` once after `ms` (immediately when `ms` is null). */
function useDoneAfter(ms: number | null, id: number, onDone: Done) {
  useEffect(() => {
    if (ms === null) {
      onDone(id);
      return;
    }
    const timer = setTimeout(() => onDone(id), ms);
    return () => clearTimeout(timer);
  }, [ms, id, onDone]);
}

/** Moves `ref` through integer world points, one keyframe per step. */
function useStepped(
  ref: RefObject<HTMLElement | null>,
  points: readonly Point[] | null,
  stepMs: number,
  scale: number,
) {
  useEffect(
    () =>
      animateSteps(
        ref.current,
        points ?? [],
        stepMs * ((points?.length ?? 1) - 1),
        scale,
      ),
    [ref, points, stepMs, scale],
  );
}

const translate = (p: Point, s: number) => ({
  transform: `translate(${p.x * s}px, ${p.y * s}px)`,
});

const Walk = memo(function Walk({
  id,
  effect,
  vm,
  scale: s,
  onDone,
}: Props<'walk-in' | 'walk-out' | 'walk-to-meeting'>) {
  const ref = useRef<HTMLDivElement>(null);
  const [plan] = useState(() => {
    const seat = seatOfAnchor(
      vm,
      effect.kind === 'walk-out' ? effect.from : effect.to,
    );
    const from = resolveAnchor(vm, effect.from);
    const to = resolveAnchor(vm, effect.to);
    if (!seat || !from || !to) return null;
    // Anchors are the seated sprite's top; the walking sprite is 8 px taller.
    const lift = (p: Point) => ({ x: p.x, y: p.y - 8 });
    const steps = walkSteps(
      walkPath(lift(from), lift(to), effect.kind !== 'walk-out'),
    );
    return { seat, steps };
  });
  const stepMs = 1000 / WALK_FPS;
  useStepped(ref, plan?.steps ?? null, stepMs, s);
  useDoneAfter(
    plan ? stepMs * Math.max(1, plan.steps.length - 1) : null,
    id,
    onDone,
  );
  if (!plan) return null;
  return (
    <div
      ref={ref}
      className={css.mover}
      data-testid={`effect-${effect.kind}`}
      style={translate(plan.steps[0]!, s)}
    >
      <Sprite
        name={characterSprite(plan.seat, 'walk')}
        scale={s}
        x={0}
        y={0}
        animation={WALK_CYCLE}
      />
    </div>
  );
});

const Envelope = memo(function Envelope({
  id,
  effect,
  vm,
  scale: s,
  onDone,
}: Props<'envelope'>) {
  const ref = useRef<HTMLDivElement>(null);
  const [plan] = useState(() => {
    const points = effect.route.map((a) => resolveAnchor(vm, a));
    if (points.some((p) => p === undefined)) return null;
    const route = (points as Point[]).map((p) => ({ x: p.x + 2, y: p.y + 4 }));
    const duration = envelopeDuration(route.length - 1);
    const length = route
      .slice(1)
      .reduce(
        (sum, p, i) => sum + Math.hypot(p.x - route[i]!.x, p.y - route[i]!.y),
        0,
      );
    const frames = Math.max(2, Math.round((duration / 1000) * 30));
    return {
      route,
      duration,
      steps: steppedPoints(route, Math.max(1, length / frames)),
    };
  });
  useStepped(
    ref,
    plan?.steps ?? null,
    plan ? plan.duration / Math.max(1, plan.steps.length - 1) : 0,
    s,
  );
  useDoneAfter(plan ? plan.duration + 300 : null, id, onDone);
  if (!plan) return null;
  const line = plan.route
    .map((p) => `${(p.x + 5) * s},${(p.y + 3) * s}`)
    .join(' ');
  return (
    <>
      <svg
        className={css.trail}
        width={vm.world.width * s}
        height={vm.world.height * s}
        aria-hidden="true"
        data-testid="effect-envelope-trail"
      >
        <polyline
          points={line}
          fill="none"
          stroke="#ffffff"
          strokeWidth={s}
          strokeDasharray={`${2 * s} ${2 * s}`}
          opacity={0.7}
        />
      </svg>
      <div
        ref={ref}
        className={css.mover}
        data-testid="effect-envelope"
        style={translate(plan.route[0]!, s)}
      >
        <Sprite name="envelope" scale={s} x={0} y={0} />
      </div>
    </>
  );
});

const Print = memo(function Print({
  id,
  scale: s,
  reducedMotion,
  onDone,
}: Props<'print'>) {
  useDoneAfter(PRINT_MS, id, onDone);
  return (
    <Sprite
      name="print"
      scale={s}
      x={placements.print.x}
      y={placements.print.y}
      frame={2}
      animation={
        reducedMotion ? null : { duration: PRINT_FRAMES_MS, iterations: 1 }
      }
      testId="effect-print"
    />
  );
});

const Parcel = memo(function Parcel({
  id,
  effect,
  vm,
  scale: s,
  onDone,
}: Props<'conveyor' | 'parcel-to-counter' | 'parcel-return' | 'merge'>) {
  const ref = useRef<HTMLDivElement>(null);
  const [plan] = useState(() => {
    const from = resolveAnchor(vm, effect.from);
    const to = resolveAnchor(vm, effect.to);
    if (!from || !to) return null;
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    const move = Math.min(1500, Math.max(400, (length / PARCEL_SPEED) * 1000));
    const steps = steppedPoints(
      [from, { x: to.x, y: from.y }, to],
      Math.max(1, length / ((move / 1000) * MOVE_FPS)),
    );
    return { from, to, move, steps };
  });
  const [landed, setLanded] = useState(false);
  useStepped(
    ref,
    plan?.steps ?? null,
    plan ? plan.move / Math.max(1, plan.steps.length - 1) : 0,
    s,
  );
  useEffect(() => {
    if (!plan || effect.kind !== 'merge') return;
    const timer = setTimeout(() => setLanded(true), plan.move);
    return () => clearTimeout(timer);
  }, [plan, effect.kind]);
  useDoneAfter(
    plan ? plan.move + (effect.kind === 'merge' ? CONFETTI_MS : 0) : null,
    id,
    onDone,
  );
  if (!plan) return null;
  return (
    <>
      {effect.kind === 'conveyor' ? (
        <Sprite
          name="conveyor"
          scale={s}
          x={placements.conveyor.x}
          y={placements.conveyor.y}
          animation={{ duration: 400, iterations: 'infinite' }}
          testId="effect-conveyor-belt"
        />
      ) : null}
      {landed ? (
        <Sprite
          name="confetti"
          scale={s}
          x={plan.to.x}
          y={plan.to.y - 6}
          testId="effect-confetti"
        />
      ) : (
        <div
          ref={ref}
          className={css.mover}
          data-testid={`effect-${effect.kind}`}
          style={translate(plan.from, s)}
        >
          <Sprite name="parcel" scale={s} x={0} y={0} />
        </div>
      )}
    </>
  );
});

const PaperGrow = memo(function PaperGrow({
  id,
  effect,
  vm,
  scale: s,
  onDone,
}: Props<'paper-grow'>) {
  const [stack] = useState(() => {
    const desk = seatOfAnchor(vm, effect.at)?.desk;
    return vm.paperStacks.find((p) => p.desk === desk) ?? null;
  });
  const from = Math.max(1, effect.fromSheets);
  const to = Math.max(from, effect.toSheets);
  const [sheets, setSheets] = useState(from);
  useEffect(() => {
    if (!stack || sheets >= to) return;
    const timer = setTimeout(() => setSheets((n) => n + 1), PAPER_STEP_MS);
    return () => clearTimeout(timer);
  }, [stack, sheets, to]);
  useDoneAfter(stack ? PAPER_STEP_MS * (to - from + 1) : null, id, onDone);
  if (!stack) return null;
  return (
    <Sprite
      name="paper-stack"
      scale={s}
      x={stack.x}
      y={stack.y - 23}
      frame={sheets - 1}
      testId="effect-paper-grow"
    />
  );
});

const DoorOpen = memo(function DoorOpen({
  id,
  scale: s,
  onDone,
}: Props<'door-open'>) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setOpen(true), DOOR_CLOSED_MS);
    return () => clearTimeout(timer);
  }, []);
  useDoneAfter(DOOR_CLOSED_MS + CONFETTI_MS, id, onDone);
  const { x, y } = placements.door;
  return (
    <>
      <Sprite
        name={open ? 'door.open' : 'door.closed'}
        scale={s}
        x={x}
        y={y}
        testId="effect-door"
      />
      {open ? (
        <Sprite
          name="confetti"
          scale={s}
          x={x + 5}
          y={y + 10}
          testId="effect-confetti"
        />
      ) : null}
    </>
  );
});

/** The outline itself is drawn by the nameplate (suppress.ts); this only times it. */
function Flash({ id, onDone }: Props<'flash-nameplate'>) {
  useDoneAfter(FLASH_MS, id, onDone);
  return null;
}

export const EffectLayer = memo(function EffectLayer({
  playing,
  vm,
  scale,
  reducedMotion,
  onDone,
}: {
  playing: readonly QueuedEffect[];
  vm: OfficeViewModel;
  scale: number;
  reducedMotion: boolean;
  onDone: Done;
}) {
  return (
    <div className={css.effects} data-testid="office-effects">
      {playing.map(({ id, effect }) => {
        const common = { id, vm, scale, reducedMotion, onDone };
        // Key by kind too: reduced motion may swap an effect for its fallback.
        const key = `${id}-${effect.kind}`;
        switch (effect.kind) {
          case 'walk-in':
          case 'walk-out':
          case 'walk-to-meeting':
            return <Walk key={key} {...common} effect={effect} />;
          case 'envelope':
            return <Envelope key={key} {...common} effect={effect} />;
          case 'print':
            return <Print key={key} {...common} effect={effect} />;
          case 'conveyor':
          case 'parcel-to-counter':
          case 'parcel-return':
          case 'merge':
            return <Parcel key={key} {...common} effect={effect} />;
          case 'paper-grow':
            return <PaperGrow key={key} {...common} effect={effect} />;
          case 'door-open':
            return <DoorOpen key={key} {...common} effect={effect} />;
          case 'flash-nameplate':
            return <Flash key={key} {...common} effect={effect} />;
        }
      })}
    </div>
  );
});
