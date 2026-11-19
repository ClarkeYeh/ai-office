import type { Point } from '../model/index.js';

/**
 * Moves `el` through integer world points with the Web Animations API, one
 * `step-end` keyframe per point (never between pixels). Returns a cancel
 * function; a cancelled animation's `finished` rejection is expected.
 */
export function animateSteps(
  el: HTMLElement | null,
  points: readonly Point[],
  duration: number,
  scale: number,
): () => void {
  if (!el || points.length < 2 || typeof el.animate !== 'function')
    return () => undefined;
  const animation = el.animate(
    points.map((p) => ({
      transform: `translate(${p.x * scale}px, ${p.y * scale}px)`,
      easing: 'step-end',
    })),
    { duration, fill: 'forwards' },
  );
  animation.finished.catch(() => undefined);
  return () => animation.cancel();
}
