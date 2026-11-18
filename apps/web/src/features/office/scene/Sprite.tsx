import { memo, type CSSProperties } from 'react';
import { atlas, SHEET_URLS, spriteOf } from './atlas.js';
import css from './scene.module.css';

export type SpriteAnimation = {
  /** One full cycle through every frame, in milliseconds. */
  duration: number;
  /** `infinite` for state loops (typing, "!"); 1 for one-shot effects. */
  iterations: number | 'infinite';
};

export type SpriteProps = {
  name: string;
  scale: number;
  /** World position of the frame's top-left; omit to place it with `style`. */
  x?: number;
  y?: number;
  /** Still frame to show (also the frame when animation is off). */
  frame?: number;
  animation?: SpriteAnimation | null;
  hidden?: boolean;
  style?: CSSProperties;
  className?: string;
  testId?: string;
};

/**
 * One atlas sprite: an `overflow: hidden` frame over a horizontal strip of all
 * its frames. Animation slides the strip with `transform: translateX` in
 * `steps()` (composited; never per-frame `background-position`).
 */
export const Sprite = memo(function Sprite({
  name,
  scale: s,
  x,
  y,
  frame = 0,
  animation,
  hidden,
  style,
  className,
  testId,
}: SpriteProps) {
  const sprite = spriteOf(name);
  if (!sprite) return null;
  const sheet = atlas.sheets[sprite.sheet];
  const animate = animation != null && sprite.frames > 1;
  const stripStyle: CSSProperties & Record<`--${string}`, string | number> = {
    width: sprite.w * sprite.frames * s,
    height: sprite.h * s,
    backgroundImage: `url(${SHEET_URLS[sprite.sheet]})`,
    backgroundSize: `${sheet.width * s}px ${sheet.height * s}px`,
    backgroundPosition: `${-sprite.x * s}px ${-sprite.y * s}px`,
  };
  if (animate) {
    stripStyle['--strip'] = `${-(sprite.frames - 1) * sprite.w * s}px`;
    stripStyle['--frames'] = sprite.frames;
    stripStyle['--dur'] = `${animation.duration}ms`;
    stripStyle['--iter'] = String(animation.iterations);
  }
  const still = Math.min(Math.max(0, frame), sprite.frames - 1);
  if (still > 0)
    stripStyle.transform = `translateX(${-still * sprite.w * s}px)`;
  return (
    <div
      className={[css.sprite, className].filter(Boolean).join(' ')}
      data-sprite={name}
      data-frame={animate ? undefined : still}
      data-animated={animate ? 'true' : undefined}
      data-testid={testId}
      aria-hidden="true"
      style={{
        ...(x === undefined ? {} : { left: x * s }),
        ...(y === undefined ? {} : { top: y * s }),
        width: sprite.w * s,
        height: sprite.h * s,
        ...(hidden ? { visibility: 'hidden' } : {}),
        ...style,
      }}
    >
      <div
        className={animate ? `${css.strip} ${css.animated}` : css.strip}
        style={stripStyle}
      />
    </div>
  );
});

export function spriteSize(name: string): { w: number; h: number } {
  const sprite = spriteOf(name);
  return sprite ? { w: sprite.w, h: sprite.h } : { w: 0, h: 0 };
}
