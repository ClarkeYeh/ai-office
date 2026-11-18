// The office floor, ported from world() in tools/sprites-src/gen/scene3.py (352×224, 16 px tiles).
// world(null) is the background: everything that changes with read-model state (TV, the door
// to main, lamps, monitors, work-area chairs, papers, parcels) is left out and drawn as sprites.
// world(stage) reproduces the mock-up boards, for the Python comparison and the review sheet.
import type { ColorName } from './palette.ts';
import { monitor, prop, type MonitorState, type PropName } from './props.ts';
import { Raster } from './raster.ts';

export const WORLD_WIDTH = 352;
export const WORLD_HEIGHT = 224;
/** Background strips (M4_PLAN §3.6): top, first work row, extra rows, bottom. */
export const TOP_HEIGHT = 104;
export const ROW_HEIGHT = 64;
export const BOTTOM_HEIGHT = WORLD_HEIGHT - TOP_HEIGHT - ROW_HEIGHT;
/** Work-area desk x positions (one row of three). */
export const DESKS = [8, 64, 120] as const;

export type Stage = 'implement' | 'meeting' | 'gate';

function rnd(x: number, y: number, k = 0): number {
  return ((x * 73856093) ^ (y * 19349663) ^ (k * 83492791)) & 0xffff;
}

function terrazzo(
  c: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  noiseY = 0,
): void {
  c.rect(x, y, w, h, 'sand');
  const chips: ColorName[] = ['tan', 'steel', 'coral', 'fawn'];
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const r = rnd(xx, yy + noiseY);
      if (r % 23 === 0) c.put(xx, yy, chips[r % 4] ?? null);
    }
}

function carpet(
  c: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  base: ColorName,
  dot: ColorName,
): void {
  c.rect(x, y, w, h, base);
  for (let yy = y + 1; yy < y + h; yy += 4)
    for (let xx = x + 1 + (Math.floor(yy / 4) % 2 ? 2 : 0); xx < x + w; xx += 4)
      c.put(xx, yy, dot);
}

function planks(c: Raster, x: number, y: number, w: number, h: number): void {
  c.rect(x, y, w, h, 'tan');
  for (let yy = y; yy < y + h; yy++) {
    if ((yy - y) % 5 === 4) c.rect(x, yy, w, 1, 'fawn');
    else {
      const off = Math.floor((yy - y) / 5) % 2 ? 13 : 0;
      for (let xx = x + off; xx < x + w; xx += 26) c.put(xx, yy, 'fawn');
    }
  }
}

function checker(c: Raster, x: number, y: number, w: number, h: number): void {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++)
      c.put(
        xx,
        yy,
        (Math.floor((xx - x) / 8) + Math.floor((yy - y) / 8)) % 2 === 0
          ? 'sand'
          : 'coral',
      );
}

function hwall(c: Raster, x: number, y: number, w: number): void {
  c.rect(x, y, w, 2, 'umber');
  c.rect(x, y + 2, w, 4, 'rust');
  c.rect(x, y + 6, w, 2, 'brown');
}

function vwall(c: Raster, x: number, y: number, h: number): void {
  c.rect(x, y, 4, h, 'umber');
  c.rect(x + 1, y, 1, h, 'brown');
}

function window(c: Raster, x: number, y: number, w = 22, h = 16): void {
  c.rect(x, y, w, h, 'umber');
  c.rect(x + 2, y + 2, w - 4, h - 5, 'sky');
  c.rect(x + 2, y + 2, w - 4, 3, 'cyan');
  c.rect(x + 4, y + 6, 6, 2, 'white');
  c.rect(x + 6, y + 5, 3, 1, 'white');
  c.rect(x + Math.floor(w / 2), y + 2, 1, h - 5, 'umber');
  c.rect(x - 1, y + h - 3, w + 2, 3, 'tan');
}

function desk(c: Raster, x: number, y: number, w: number, d = 16): void {
  c.rect(x, y, w, d, 'tan');
  c.rect(x, y, w, 1, 'sand');
  c.rect(x, y + d - 1, w, 1, 'fawn');
  c.rect(x, y + d, w, 4, 'brick');
  c.rect(x, y + d + 3, w, 1, 'brown');
  c.rect(x + 1, y + d + 4, 2, 3, 'brown');
  c.rect(x + w - 3, y + d + 4, 2, 3, 'brown');
}

/** A paper stack of n sheets whose lowest sheet sits on row ybottom. */
export function stack(
  c: Raster,
  x: number,
  ybottom: number,
  sheets: number,
): void {
  for (let i = 0; i < sheets; i++) {
    const yy = ybottom - 2 * i;
    c.rect(x, yy - 1, 9, 1, 'white');
    c.rect(x + (i % 2), yy, 9, 1, 'mist');
  }
}

function put(c: Raster, name: PropName, x: number, y: number): void {
  c.draw(prop(name), x, y);
}

/** The meeting-room TV (42×19); its screen is lit only during the meeting. */
export function tv(meeting: boolean): Raster {
  const c = new Raster(42, 19);
  c.rect(0, 0, 42, 19, 'ink');
  c.rect(2, 2, 38, 14, meeting ? 'sky' : 'dusk');
  if (meeting)
    for (let i = 0; i < 3; i++)
      c.rect(5, 5 + 3 * i, 18 + 6 * (i % 2), 1, 'white');
  return c;
}
export const TV_AT = { x: 36, y: 4 } as const;

/**
 * The door to main (26×32). The mock-up knob was amber; it is lemon because amber only
 * means "needs you". The open door shows the dark doorway and the leaf swung inwards.
 */
export function door(open: boolean): Raster {
  const c = new Raster(26, 32);
  c.rect(8, 0, 10, 3, 'ink');
  c.rect(0, 3, 26, 29, 'umber');
  if (open) {
    c.rect(2, 5, 22, 27, 'night');
    c.rect(2, 5, 5, 27, 'fawn');
    c.rect(3, 7, 3, 10, 'tan');
    c.rect(3, 19, 3, 11, 'tan');
    c.rect(7, 5, 1, 27, 'brown');
    return c;
  }
  c.rect(2, 5, 22, 27, 'fawn');
  c.rect(4, 7, 8, 10, 'tan');
  c.rect(14, 7, 8, 10, 'tan');
  c.rect(4, 19, 8, 11, 'tan');
  c.rect(14, 19, 8, 11, 'tan');
  c.rect(20, 17, 2, 3, 'lemon');
  return c;
}
export const DOOR_AT = { x: 310, y: 0 } as const;

/** Light under your lamp when it is on (16×4, drawn at LAMP_GLOW_AT). */
export function lampGlow(): Raster {
  const c = new Raster(16, 4);
  for (const [dx, dy] of [
    [-3, 10],
    [-2, 12],
    [2, 12],
    [6, 11],
    [10, 13],
    [-5, 13],
  ] as const)
    c.put(296 + dx - 291, 66 + dy - 76, 'lemon');
  return c;
}
export const LAMP_GLOW_AT = { x: 291, y: 76 } as const;

/** A sheet of paper (10×7): your inbox, the meeting table. */
export function paperSheet(): Raster {
  const c = new Raster(10, 7);
  c.rect(0, 0, 10, 7, 'white');
  c.rect(1, 2, 7, 1, 'mist');
  c.rect(1, 4, 5, 1, 'mist');
  return c;
}

/** The reserved-seat note on a waiting desk (10×7). */
export function paperNote(): Raster {
  const c = new Raster(10, 7);
  c.rect(0, 0, 10, 7, 'white');
  c.rect(0, 0, 10, 1, 'coral');
  c.rect(2, 3, 6, 1, 'slate');
  return c;
}

/** A desk of the work area, with its keyboard, at the row whose top is y0. */
function workRow(c: Raster, y0: number): void {
  for (const dx of DESKS) {
    desk(c, dx, y0 + 12, 40, 16);
    c.rect(dx + 14, y0 + 16, 12, 3, 'mist');
    c.rect(dx + 15, y0 + 17, 10, 1, 'steel');
  }
}

/** An extra work row (352×64) for maxParallel > 3: floor, outer walls and three desks. */
export function extraRow(): Raster {
  const c = new Raster(WORLD_WIDTH, ROW_HEIGHT);
  terrazzo(c, 0, 0, WORLD_WIDTH, ROW_HEIGHT, TOP_HEIGHT);
  c.rect(0, 0, 2, ROW_HEIGHT, 'umber');
  c.rect(WORLD_WIDTH - 2, 0, 2, ROW_HEIGHT, 'umber');
  workRow(c, 0);
  return c;
}

/** The whole floor; null = the background without state-dependent elements. */
export function world(stage: Stage | null): Raster {
  const W = WORLD_WIDTH;
  const H = WORLD_HEIGHT;
  const c = new Raster(W, H);
  // floors
  terrazzo(c, 0, 32, W, H - 32);
  carpet(c, 0, 32, 112, 64, 'navyblue', 'sky'); // meeting room
  carpet(c, 124, 40, 40, 48, 'plum', 'rose'); // lead's rug
  c.rect(124, 40, 40, 1, 'rose');
  c.rect(124, 87, 40, 1, 'rose');
  planks(c, 260, 32, 92, 64); // your office
  checker(c, 0, 176, 112, 48); // pantry
  // back wall
  c.rect(0, 0, W, 3, 'umber');
  c.rect(0, 3, W, 21, 'rust');
  c.rect(0, 24, W, 1, 'tan');
  c.rect(0, 25, W, 7, 'brown');
  for (let x = 0; x < W; x += 8) c.rect(x, 25, 1, 7, 'umber');
  window(c, 6, 5);
  window(c, 86, 5);
  window(c, 122, 5);
  window(c, 266, 5);
  if (stage) c.draw(tv(stage === 'meeting'), TV_AT.x, TV_AT.y);
  put(c, 'clock', 152, 8);
  // whiteboard + corkboard in the hall
  c.rect(180, 3, 56, 21, 'steel');
  c.rect(182, 5, 52, 17, 'white');
  c.rect(186, 22, 44, 2, 'slate');
  put(c, 'corkboard', 238, 7);
  if (stage) c.draw(door(false), DOOR_AT.x, DOOR_AT.y);
  // interior walls
  vwall(c, 112, 32, 72);
  vwall(c, 172, 32, 72);
  vwall(c, 256, 32, 72);
  hwall(c, 0, 96, 84);
  hwall(c, 104, 96, 12);
  hwall(c, 116, 96, 4);
  hwall(c, 136, 96, 40);
  hwall(c, 260, 96, 8);
  hwall(c, 288, 96, 64);
  hwall(c, 0, 168, 72);
  hwall(c, 96, 168, 20);
  vwall(c, 112, 168, 56);
  c.rect(0, 32, 2, H - 32, 'umber');
  c.rect(W - 2, 32, 2, H - 32, 'umber');
  c.rect(0, H - 2, W, 2, 'umber');
  c.rect(140, 216, 32, 6, 'slate'); // entrance mat

  // ---- meeting room (the background keeps the arrangement between meetings)
  const meet = stage === 'meeting';
  for (const x of [26, 74]) put(c, 'chair_front', x, 44);
  if (!meet) put(c, 'chair_front', 50, 44);
  c.rect(20, 56, 72, 20, 'tan');
  c.rect(20, 56, 72, 1, 'sand');
  c.rect(20, 75, 72, 1, 'fawn');
  c.rect(20, 76, 72, 4, 'brick');
  c.rect(20, 79, 72, 1, 'brown');
  for (const x of [21, 89]) c.rect(x, 80, 2, 3, 'brown');
  if (meet) {
    for (const [x, w] of [
      [28, 10],
      [52, 9],
      [76, 10],
    ] as const) {
      c.rect(x, 62, w, 7, 'white');
      c.rect(x + 1, 64, w - 3, 1, 'mist');
      c.rect(x + 1, 66, w - 4, 1, 'mist');
    }
  } else {
    c.rect(50, 62, 11, 8, 'white');
    c.rect(51, 64, 8, 1, 'mist');
    c.rect(51, 66, 6, 1, 'mist');
    put(c, 'chair_back', 32, 82);
    put(c, 'chair_back', 64, 82);
    put(c, 'chair_front', 96, 58);
  }
  if (meet) put(c, 'chair_back', 32, 82);
  put(c, 'plant', 94, meet ? 80 : 78);

  // ---- lead's office
  put(c, 'chair_front', 137, 48);
  desk(c, 128, 60, 32, 12);
  put(c, 'mon_back', 130, 52);
  put(c, 'mug', 150, 63);
  put(c, 'plant', 156, 34);

  // ---- hall: printer, in/out trays, trash
  put(c, 'printer', 180, 58);
  if (stage === 'implement') {
    c.rect(184, 71, 8, 6, 'white');
    c.rect(185, 73, 6, 1, 'slate');
    c.rect(185, 75, 4, 1, 'slate');
  }
  c.rect(204, 78, 24, 14, 'fawn');
  c.rect(204, 78, 24, 1, 'tan');
  c.rect(204, 91, 24, 1, 'brown');
  c.rect(215, 82, 2, 2, 'brown');
  put(c, 'tray', 206, 64);
  put(c, stage === 'meeting' ? 'tray_empty' : 'tray', 206, 71);
  put(c, 'trash', 240, 82);
  put(c, 'plant', 236, 34);

  // ---- your office
  put(c, 'chair_front', 305, 52);
  desk(c, 290, 64, 44, 14);
  put(c, 'mon_back', 318, 56);
  if (stage) put(c, stage === 'gate' ? 'lamp_on' : 'lamp_off', 293, 56);
  c.rect(304, 68, 12, 7, 'fawn');
  c.rect(305, 69, 10, 5, 'tan');
  if (stage === 'gate') {
    c.draw(paperSheet(), 305, 66);
    c.draw(lampGlow(), LAMP_GLOW_AT.x, LAMP_GLOW_AT.y);
  }
  put(c, 'plant', 336, 78);
  put(c, 'cactus', 272, 14);

  // ---- work area
  workRow(c, 104);
  if (stage) {
    const tools: Record<Stage, MonitorState[]> = {
      implement: ['edit', 'off', 'off'],
      meeting: ['off', 'off', 'off'],
      gate: ['off', 'off', 'off'],
    };
    const sheets: Record<Stage, number[]> = {
      implement: [5, 8, 0],
      meeting: [0, 0, 0],
      gate: [0, 0, 0],
    };
    DESKS.forEach((dx, i) => {
      c.draw(monitor(tools[stage][i] ?? 'off'), dx + 13, 107);
      const n = sheets[stage][i] ?? 0;
      if (n) stack(c, dx + 29, 128, n);
    });
    if (stage === 'implement') {
      put(c, 'mug', DESKS[0] + 3, 119);
      put(c, 'chair_back', DESKS[1] + 18, 143); // feature: chair pushed out
      put(c, 'chair_back', DESKS[2] + 13, 137); // dependent: tucked in
      c.draw(paperNote(), DESKS[2] + 3, 118);
    } else for (const dx of DESKS) put(c, 'chair_back', dx + 13, 137);
  }
  put(c, 'plant', 164, 102);

  // ---- merge zone: conveyor + integrator counter
  c.rect(172, 142, 112, 1, 'mist');
  c.rect(172, 160, 112, 1, 'mist');
  c.rect(172, 146, 108, 2, 'steel');
  c.rect(172, 156, 108, 2, 'steel');
  conveyorBelt(c, 172, 148, 0);
  for (const x of [178, 214, 250]) c.rect(x, 158, 3, 3, 'slate');
  c.rect(168, 144, 8, 16, 'slate'); // drop-in hopper
  c.rect(169, 145, 6, 1, 'steel');
  // counter
  c.rect(280, 128, 68, 12, 'tan');
  c.rect(280, 128, 68, 1, 'sand');
  c.rect(280, 139, 68, 1, 'fawn');
  c.rect(280, 140, 68, 18, 'navyblue');
  for (let x = 283; x < 348; x += 6) c.rect(x, 141, 2, 16, 'sky');
  c.rect(280, 157, 68, 2, 'umber');
  put(c, 'mon_back', 330, 120);
  if (stage === 'implement') put(c, 'box', 289, 124);
  else if (stage) {
    // The mock-up's review sheet had a red line; red only means an error, so it is coral.
    c.rect(296, 130, 18, 7, 'white');
    c.rect(297, 132, 16, 1, 'coral');
    c.rect(297, 134, 12, 1, 'slate');
  }
  // merge cart (integration branch)
  c.rect(292, 190, 52, 24, 'brown');
  c.rect(294, 192, 48, 20, 'fawn');
  for (let x = 296; x < 342; x += 8) c.rect(x, 192, 2, 20, 'brick');
  c.rect(292, 190, 52, 2, 'umber');
  c.rect(296, 214, 4, 4, 'ink');
  c.rect(336, 214, 4, 4, 'ink');
  // lounge: rug, sofa, coffee table
  c.rect(160, 192, 92, 22, 'clay');
  c.rect(162, 194, 88, 18, 'tan');
  for (let x = 164; x < 250; x += 6) c.rect(x, 202, 3, 1, 'clay');
  c.rect(166, 180, 72, 2, 'rose');
  c.rect(166, 182, 72, 6, 'plum');
  c.rect(170, 188, 64, 5, 'rose');
  c.rect(170, 193, 64, 3, 'plum');
  c.rect(164, 184, 6, 12, 'plum');
  c.rect(234, 184, 6, 12, 'plum');
  c.rect(164, 184, 6, 1, 'rose');
  c.rect(234, 184, 6, 1, 'rose');
  c.rect(166, 196, 2, 2, 'umber');
  c.rect(236, 196, 2, 2, 'umber');
  c.rect(188, 202, 28, 6, 'tan');
  c.rect(188, 202, 28, 1, 'sand');
  c.rect(188, 208, 28, 3, 'brick');
  c.rect(196, 199, 7, 4, 'white');
  c.rect(197, 200, 5, 1, 'mist');

  // ---- pantry
  c.rect(6, 182, 58, 8, 'tan');
  c.rect(6, 182, 58, 1, 'sand');
  c.rect(6, 190, 58, 8, 'brick');
  c.rect(6, 197, 58, 1, 'brown');
  put(c, 'coffee', 12, 172);
  put(c, 'mug', 30, 183);
  put(c, 'mug', 40, 183);
  c.rect(70, 176, 18, 32, 'mist');
  c.rect(70, 176, 18, 1, 'white');
  c.rect(70, 189, 18, 1, 'steel');
  c.rect(84, 180, 1, 6, 'slate');
  c.rect(84, 192, 1, 8, 'slate');
  c.rect(70, 207, 18, 1, 'steel');
  c.rect(28, 206, 22, 8, 'tan');
  c.rect(28, 206, 22, 1, 'sand');
  c.rect(28, 213, 22, 2, 'fawn');
  c.rect(36, 215, 6, 5, 'brown');
  put(c, 'plant', 92, 200);
  put(c, 'plant', 118, 196);
  put(c, 'trash', 262, 204);
  return c;
}

/** The conveyor belt surface (108×8) with its ribs moved `offset` (0–4) px towards the counter. */
export function conveyorBelt(
  c: Raster,
  x: number,
  y: number,
  offset: number,
): void {
  c.rect(x, y, 108, 8, 'ink');
  for (let xx = x + ((2 + offset) % 5); xx < x + 108; xx += 5)
    c.rect(xx, y, 1, 8, 'dusk');
}
export const CONVEYOR_AT = { x: 172, y: 148 } as const;
