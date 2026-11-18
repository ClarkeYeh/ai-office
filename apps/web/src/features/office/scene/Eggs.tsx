import { memo, useEffect, useRef, useState } from 'react';
import { placements } from './atlas.js';
import {
  CLOCK,
  coffeeMachine,
  pad2,
  PLANT_SIZE,
  plants,
  shiftY,
  steppedPoints,
} from './geometry.js';
import { Hit } from './Hit.js';
import type { SceneTranslate } from './messages.js';
import { animateSteps } from './motion.js';
import { Sprite } from './Sprite.js';
import css from './scene.module.css';

// D11 easter eggs, click-only (M4_DESIGN §3.4): a plant drops a leaf, the coffee
// machine fills the mug, the clock re-reads the local time for the sky colour.

const LEAF_MS = 600;
const POUR_MS = 375;
const CLOCK_TIP_MS = 2500;

function Leaf({
  from,
  scale: s,
  reducedMotion,
  onDone,
}: {
  from: { x: number; y: number };
  scale: number;
  reducedMotion: boolean;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const to = { x: from.x + 2, y: from.y + 14 };
  useEffect(() => {
    const timer = setTimeout(onDone, LEAF_MS);
    const cancel = reducedMotion
      ? () => undefined
      : animateSteps(ref.current, steppedPoints([from, to], 1), LEAF_MS, s);
    return () => {
      clearTimeout(timer);
      cancel();
    };
    // The leaf plays once from where it was created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const at = reducedMotion ? to : from;
  return (
    <div
      ref={ref}
      className={css.mover}
      data-testid="egg-leaf"
      style={{ transform: `translate(${at.x * s}px, ${at.y * s}px)` }}
    >
      <Sprite name="leaf" scale={s} x={0} y={0} />
    </div>
  );
}

export const Eggs = memo(function Eggs({
  rows,
  scale: s,
  interactive,
  reducedMotion,
  t,
  onClock,
  now,
}: {
  rows: number;
  scale: number;
  interactive: boolean;
  reducedMotion: boolean;
  t: SceneTranslate;
  /** Re-read the local time: the scene recomputes the sky. */
  onClock: () => void;
  now: () => Date;
}) {
  const [leaves, setLeaves] = useState<{ id: number; plant: number }[]>([]);
  const [poured, setPoured] = useState(0);
  const [clockTip, setClockTip] = useState<string | null>(null);
  const nextLeaf = useRef(0);
  useEffect(() => {
    if (clockTip === null) return;
    const timer = setTimeout(() => setClockTip(null), CLOCK_TIP_MS);
    return () => clearTimeout(timer);
  }, [clockTip]);

  const plantPoints = plants(rows);
  const coffee = coffeeMachine(rows);
  const mug = {
    x: placements.pantryMug.x,
    y: shiftY(placements.pantryMug.y, rows),
  };
  return (
    <>
      {plantPoints.map((p, i) => (
        <Hit
          key={i}
          interactive={interactive}
          testId={`egg-plant-${i}`}
          ariaLabel={t('office.scene.plant')}
          rect={{ ...p, ...PLANT_SIZE }}
          scale={s}
          tabIndex={-1}
          onClick={() =>
            setLeaves((list) => [...list, { id: nextLeaf.current++, plant: i }])
          }
        />
      ))}
      {leaves.map((leaf) => {
        const p = plantPoints[leaf.plant]!;
        return (
          <Leaf
            key={leaf.id}
            from={{ x: p.x + 6, y: p.y + 3 }}
            scale={s}
            reducedMotion={reducedMotion}
            onDone={() =>
              setLeaves((list) => list.filter((l) => l.id !== leaf.id))
            }
          />
        );
      })}
      <Hit
        interactive={interactive}
        testId="egg-coffee"
        ariaLabel={t('office.scene.coffee')}
        rect={coffee}
        scale={s}
        tabIndex={-1}
        onClick={() => setPoured((n) => n + 1)}
      />
      {poured > 0 ? (
        <Sprite
          key={poured}
          name="coffee-pour"
          scale={s}
          x={mug.x}
          y={mug.y}
          frame={2}
          animation={
            reducedMotion ? null : { duration: POUR_MS, iterations: 1 }
          }
          testId="egg-coffee-mug"
        />
      ) : null}
      <Hit
        interactive={interactive}
        testId="egg-clock"
        ariaLabel={t('office.scene.clock')}
        rect={CLOCK}
        scale={s}
        tabIndex={-1}
        onClick={() => {
          const date = now();
          onClock();
          setClockTip(
            t('office.scene.clockTime', {
              time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
            }),
          );
        }}
      />
      {clockTip === null ? null : (
        <span
          className={css.tooltip}
          role="status"
          data-testid="egg-clock-time"
          style={{ left: (CLOCK.x - 8) * s, top: (CLOCK.y + CLOCK.h + 2) * s }}
        >
          {clockTip}
        </span>
      )}
    </>
  );
});
