import { memo } from 'react';
import type { OfficeSeat } from '../model/index.js';
import { characterSprite } from './geometry.js';
import { Sprite, spriteSize } from './Sprite.js';
import css from './scene.module.css';

/**
 * The seat inspector's portrait (M4_DESIGN §4.2): the role's front upper body
 * with its vendor shirt and accessory colour. Pure display, exported through the
 * office index for the seats feature.
 */
export const Avatar = memo(function Avatar({
  seat,
  scale = 4,
  label,
}: {
  seat: Pick<OfficeSeat, 'role' | 'vendor' | 'accessory'>;
  scale?: number;
  /** Accessible name; omit when the surrounding text already names the seat. */
  label?: string;
}) {
  const name = characterSprite(seat, 'upper');
  const { w, h } = spriteSize(name);
  return (
    <span
      className={css.avatar}
      data-testid="seat-avatar"
      style={{ width: (w + 4) * scale, height: (h + 2) * scale }}
      {...(label === undefined
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label })}
    >
      <Sprite name={name} scale={scale} x={2} y={2} />
    </span>
  );
});
