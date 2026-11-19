// Characters (M4_DESIGN §2.4–§2.6): one body template, a head per role, a shirt per vendor.
// Ported from tools/sprites-src/m4-pixel-src/sprites.py. Map letters:
//   o outline  H/h hair  S/s skin  e eye  W white  m mouth  q blush  k glasses
//   A/a role accessory (tie, hair band, glasses, beanie, visor)  C/c shirt  b badge
//   L/l trousers  F shoes  n/N chair (dark / light)
// The architect's glasses use the accessory slot (A) so that colour variants reach them.
import {
  accessoryOf,
  ROLE_LOOK,
  type AccessoryName,
  type Role,
} from './accessories.ts';
import { sprite } from './maps.ts';
import type { ColorMap } from './raster.ts';
import { Raster } from './raster.ts';
import { VENDOR_LOOK, type Vendor } from './vendors.ts';

const BASE = {
  o: 'umber',
  e: 'ink',
  W: 'white',
  m: 'brown',
  q: 'coral',
  k: 'ink',
  L: 'dusk',
  l: 'ink',
  F: 'ink',
  n: 'plum',
  N: 'rose',
} as const satisfies ColorMap;

const HEAD: Readonly<Record<Role, string>> = {
  lead: `................
.....oooooo.....
....oHHHHHHo....
...oHHHHHhHHo...
..oHHHHHhHHHHo..
..oHHHHhHHHHHo..
..oHHSSSSSSHHo..
..oHSSSSSSSSHo..
..oSSeWSSeWSSo..
..oSSeeSSeeSSo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
`,
  pm: `................
.....oooooo.....
....oHHHHHHoo...
...oHHHHHHHHHo..
..oHHHHHHHHHHHo.
..oHAAAAAAAAHHo.
..oHHHSSSSHHHoHo
..oHSSSSSSSSHoHo
..oSSeWSSeWSSoHo
..oSSeeSSeeSSohH
..oSSSSSSSSSSo.o
..osqSSmmSSqso..
...osSSSSSSso...
....ooSSSSoo....
`,
  architect: `................
....oo.oo.oo....
...oHHoHHoHHo...
..oHHHHHHHHHHo..
.oHHhHHHhHHHhHo.
.oHHHHHHHHHHHHo.
..oHHSSSSSSHHo..
..oHAAAAAAAAHo..
..oSAeWAAeWASo..
..oSAAAAAAAASo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
`,
  engineer: `.......aa.......
.....oooooo.....
....oAAAAAAo....
...oAAAAAAAAo...
..oAAAAAAAAAAo..
..oaaaaaaaaaao..
..oHHSSSSSSHHo..
..oHSSSSSSSSHo..
..oSSeWSSeWSSo..
..oSSeeSSeeSSo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
`,
  integrator: `................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oAAAAAAAAAAo..
.oaaaaaaaaaaaao.
..oHSSSSSSSSHo..
..oSSSSSSSSSSo..
..oSSeWSSeWSSo..
..oSSeeSSeeSSo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
`,
};

const BODY = `.....oCWWCo.....
...ooCCCCCCoo...
..oCCCCCCCCCCo..
..ocCCCCCCbbco..
..ocCCCCCCbbco..
..ocCCCCCCCCco..
..ocCCCCCCCCco..
..ocCCCCCCCCco..
..oSoLLLLLLoSo..
...ooLLLLLLoo...
....oLLllLLo....
....oLLooLLo....
....oLLooLLo....
....oLLooLLo....
....oLLooLLo....
...oFFFooFFFo...
...oooo..oooo...
................
`;

/** Body rows that get the lead's tie at x 7–8. */
const TIE_ROWS = new Set([1, 2, 3, 4, 5, 6]);

const BACK_HEAD: Readonly<Partial<Record<Role, string>> & { default: string }> =
  {
    default: `................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oHHHHhHHHHHo..
..oHHHHHHhHHHo..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
`,
    engineer: `.......aa.......
.....oooooo.....
....oAAAAAAo....
...oAAAAAAAAo...
..oAAAAAAAAAAo..
..oaaaaaaaaaao..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
`,
    integrator: `................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oAAAAAAAAAAo..
..oaHHHHHHHHao..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
`,
    pm: `................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oHHHHhHHHHHo..
..oAAAAAAAAAAo..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhoHhhho...
....oossHsoo....
`,
    architect: `................
....oo.oo.oo....
...oHHoHHoHHo...
..oHHHHHHHHHHo..
.oHHhHHHhHHHhHo.
.oHHHHHHHHHHHHo.
..oHHHHHHHHHHo..
..oAHHHHHHHHAo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
`,
  };

const BACK_SEAT = [
  `...ooCCCCCCoo...
..oCCCCCCCCCCo..
.oSCCCCCCCCCCSo.
..ocCCCCCCCCco..
..oNNNNNNNNNNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oooooooooooo..
.......oo.......
.....oooooo.....
`,
  `...ooCCCCCCoo...
.oSCCCCCCCCCCSo.
..oCCCCCCCCCCo..
..ocCCCCCCCCco..
..oNNNNNNNNNNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oooooooooooo..
.......oo.......
.....oooooo.....
`,
] as const;

/** Leg rows for the walk cycle (body rows 13–16); the other rows stay as in BODY. */
const WALK_LEGS = {
  left: [
    '...oFFFooLLo....',
    '...oooo.oLLo....',
    '........oFFFo...',
    '........oooo....',
  ],
  right: [
    '....oLLooFFFo...',
    '....oLLo.oooo...',
    '...oFFFo........',
    '...oooo.........',
  ],
} as const;

export interface Look {
  readonly role: Role;
  readonly vendor: Vendor;
  readonly accessory: AccessoryName;
}

export function colorsOf({ role, vendor, accessory }: Look): ColorMap {
  return {
    ...BASE,
    ...ROLE_LOOK[role],
    ...accessoryOf(role, accessory),
    ...VENDOR_LOOK[vendor],
  };
}

function frontRows(
  role: Role,
  rows: number,
  legs?: keyof typeof WALK_LEGS,
): string[] {
  const head = sprite(HEAD[role], 16);
  let body = sprite(BODY, 16);
  if (role === 'lead')
    body = body.map((row, i) =>
      TIE_ROWS.has(i) ? row.slice(0, 7) + 'aa' + row.slice(9) : row,
    );
  if (legs) body.splice(13, 4, ...WALK_LEGS[legs]);
  return [...head, ...body].slice(0, rows);
}

/**
 * Standing, facing the camera: 32 rows for the full figure, 22 for the upper body
 * behind a desk. Closed eyes are the leaning-back idle pose.
 */
export function charFront(look: Look, rows = 32, eyesClosed = false): Raster {
  const map = frontRows(look.role, rows);
  if (eyesClosed && map[8]) map[8] = map[8].replaceAll('eW', 'SS');
  const out = new Raster(16, rows);
  out.blit(map, 0, 0, colorsOf(look));
  return out;
}

/** Seated from behind (16×24): typing frame 0 or 1; slump moves the head down (error). */
export function charBack(look: Look, frame: 0 | 1 = 0, slump = 0): Raster {
  const head = sprite(BACK_HEAD[look.role] ?? BACK_HEAD.default, 16);
  const seat = sprite(BACK_SEAT[frame], 16);
  const colors = colorsOf(look);
  const out = new Raster(16, 24);
  out.blit(seat, 0, 13, colors);
  out.blit(head, 0, slump, colors);
  return out;
}

/** The four walk frames (16×32): stand, left step, stand, right step. */
export function charWalk(look: Look): Raster[] {
  const colors = colorsOf(look);
  return [undefined, 'left', undefined, 'right'].map((legs) => {
    const out = new Raster(16, 32);
    out.blit(
      frontRows(look.role, 32, legs as keyof typeof WALK_LEGS | undefined),
      0,
      0,
      colors,
    );
    return out;
  });
}
