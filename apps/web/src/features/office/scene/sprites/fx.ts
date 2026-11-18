// Effect sprites (M4_DESIGN §3.3–§3.4). Named fx.ts so it is not confused with model/effects.ts.
// Multi-frame effects return one raster per frame, all the same size.
import { conveyorBelt, stack } from './floor.ts';
import { rasterOf, sprite } from './maps.ts';
import { prop } from './props.ts';
import { Raster } from './raster.ts';

/** The "!" bubble bobbing by 2 px (10×15, 2 frames); the only persistent reminder. */
export function bang(): Raster[] {
  return [2, 0].map((y) => {
    const c = new Raster(10, 15);
    c.draw(prop('bang'), 0, y);
    return c;
  });
}

/** Printer output for a new PR (8×6, 3 frames): the sheet comes out of the printer. */
export function printing(): Raster[] {
  return [2, 4, 6].map((rows) => {
    const c = new Raster(8, 6);
    c.rect(0, 0, 8, rows, 'white');
    if (rows > 2) c.rect(1, 2, 6, 1, 'slate');
    if (rows > 4) c.rect(1, 4, 4, 1, 'slate');
    return c;
  });
}
export const PRINT_AT = { x: 184, y: 71 } as const;

/** The conveyor belt scrolling towards the counter (108×8, 5 frames = one rib period). */
export function conveyor(): Raster[] {
  return [0, 1, 2, 3, 4].map((offset) => {
    const c = new Raster(108, 8);
    conveyorBelt(c, 0, 0, offset);
    return c;
  });
}

/** Pouring coffee into the pantry mug (7×9, 3 frames): empty, pouring, full with steam. */
export function coffeePour(): Raster[] {
  return [0, 1, 2].map((frame) => {
    const c = new Raster(7, 9);
    c.draw(prop('mug'), 0, 3);
    if (frame >= 1) c.rect(1, 4, 3, 1, 'brown');
    if (frame === 1) c.rect(2, 0, 1, 4, 'brown');
    if (frame === 2) {
      c.put(1, 1, 'mist');
      c.put(2, 0, 'mist');
      c.put(3, 2, 'mist');
    }
    return c;
  });
}

/** A falling leaf for the plant easter egg (4×3). */
export function leaf(): Raster {
  return rasterOf(sprite('.GG.\nGGhh\n.h..'), { G: 'leaf', h: 'fern' });
}

/** Seat token usage as a paper stack (10×24): frame n has n + 1 sheets, up to 12. */
export function paperStack(): Raster[] {
  return Array.from({ length: 12 }, (_, i) => {
    const c = new Raster(10, 24);
    stack(c, 0, 23, i + 1);
    return c;
  });
}

/** Static screen noise over a degraded seat's monitor screen (10×5). */
export function monitorNoise(): Raster {
  return rasterOf(
    sprite('W.s..m.W..\n..m.W...s.\ns...m.W..m\n.W.s...m..\n..m..W.s.W'),
    {
      W: 'white',
      m: 'mist',
      s: 'steel',
    },
  );
}
