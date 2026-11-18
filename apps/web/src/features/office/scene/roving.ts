// Roving tabindex across seats (M4_DESIGN §5.4): one seat is tabbable; arrow
// keys move to the nearest seat in that direction by floor position.

export type RovingPoint = { id: string; x: number; y: number };
export type Direction = 'left' | 'right' | 'up' | 'down';

export const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/**
 * The nearest point strictly in `direction`, weighting the cross axis twice so
 * a seat in the same row wins over a diagonal one; undefined at the edge.
 */
export function neighbour(
  points: readonly RovingPoint[],
  fromId: string,
  direction: Direction,
): string | undefined {
  const from = points.find((p) => p.id === fromId);
  if (!from) return points[0]?.id;
  let best: { id: string; cost: number } | undefined;
  for (const p of points) {
    if (p.id === fromId) continue;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const [main, cross] =
      direction === 'left'
        ? [-dx, dy]
        : direction === 'right'
          ? [dx, dy]
          : direction === 'up'
            ? [-dy, dx]
            : [dy, dx];
    if (main <= 0) continue;
    const cost = main + 2 * Math.abs(cross);
    if (!best || cost < best.cost) best = { id: p.id, cost };
  }
  return best?.id;
}

/** The tabbable seat: the remembered one if still present, else the selection, else the first. */
export function rovingId(
  ids: readonly string[],
  remembered: string | null,
  selected: string | undefined,
): string | undefined {
  if (remembered !== null && ids.includes(remembered)) return remembered;
  return selected ?? ids[0];
}
