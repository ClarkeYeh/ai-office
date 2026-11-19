import type { CSSProperties } from 'react';
import type { OfficeSeat, Point } from '../model/index.js';
import css from './scene.module.css';

/** Fixed bubble zones from V3Meeting keep prose above/beside the faces. */
export function SpeechBubble({
  seat,
  scale: s,
  origin,
}: {
  seat: OfficeSeat;
  scale: number;
  origin: Point;
}) {
  const bubble = seat.bubble;
  if (!bubble) return null;
  const chair = seat.chair;
  const zone =
    chair === 'facilitator'
      ? { x: 120, y: 40, w: 66, tail: 'left' }
      : chair === 0
        ? { x: 2, y: 3, w: 62, tail: 'down' }
        : chair === 1
          ? { x: 68, y: 3, w: 70, tail: 'down' }
          : chair === 4
            ? { x: 140, y: 3, w: 38, tail: 'down' }
            : { x: chair === 3 ? 2 : 45, y: 104, w: 66, tail: 'up' };
  return (
    <span
      className={css.bubble}
      data-tail={zone.tail}
      data-testid={`${seat.testId}-bubble`}
      role="img"
      aria-label={bubble.label}
      title={bubble.label}
      style={
        {
          '--tail-x': `${Math.max(3, Math.min(zone.w - 5, seat.x + 8 - zone.x)) * s}px`,
          left: (zone.x - origin.x) * s,
          top: (zone.y - origin.y) * s,
          width: zone.w * s,
          maxHeight: 22 * s,
          fontSize: Math.max(10, Math.round(4 * s)),
          borderWidth: s,
        } as CSSProperties
      }
    >
      <span>{bubble.position}</span>
    </span>
  );
}
