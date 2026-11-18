// Furniture, small props and effect maps, ported from tools/sprites-src/m4-pixel-src/sprites.py.
// Signal colours keep their meaning (M4_DESIGN §2.2): the envelope seal is coral instead of
// red, and the confetti uses coral and lemon instead of red and amber.
import type { ColorName } from './palette.ts';
import { rasterOf, sprite } from './maps.ts';
import type { ColorMap, Raster } from './raster.ts';

interface PropMap {
  readonly map: string;
  /** null for maps that are always recoloured (the monitors). */
  readonly colors: ColorMap | null;
}

const PROP_MAPS = {
  plant: {
    map: `.......G........
....G..GG..G....
...GGhGGhhGGh...
..hGGGhGGhGGGh..
..hGhGGGhGGhGh..
...hhGGhGGhGhh..
....hhhGhhhhh...
......hhhhh.....
....oooooooo....
....oTTTTTTo....
....owwwwwwo....
....owvvvvwo....
.....owwwwo.....
.....oooooo.....
`,
    colors: {
      G: 'leaf',
      h: 'fern',
      o: 'umber',
      T: 'sand',
      w: 'brick',
      v: 'brown',
    },
  },
  cactus: {
    map: `....oo....
...oGGo...
.o.oGGo.o.
oGooGhooGo
oGGGGhGGGo
.ooGGhGoo.
...oGhGo..
..oooooo..
..owwwwo..
...owwo...
...oooo...
`,
    colors: { G: 'leaf', h: 'fern', o: 'pine', w: 'clay' },
  },
  mon_on: {
    map: `.oooooooooooo.
okkkkkkkkkkkko
okSSSSSSSSSSko
okSLLLSLLSSSko
okSSSLLLLSSSko
okSLLSSLLLSSko
okSSSSSSSSSSko
.okkkkkkkkkko.
......kk......
....kkkkkk....
`,
    colors: null,
  },
  mon_off: {
    map: `.oooooooooooo.
okkkkkkkkkkkko
okSSSSSSSSLSko
okSSSSSSSLSSko
okSSSSSSLSSSko
okSSSSSLSSSSko
okSSSSSSSSSSko
.okkkkkkkkkko.
......kk......
....kkkkkk....
`,
    colors: null,
  },
  mon_back: {
    map: `.oooooooooo.
oggggggggggo
ogmmmmmmmmgo
ogmggggggmgo
ogmmmmmmmmgo
oggggggggggo
.oooooooooo.
.....oo.....
...oooooo...
`,
    colors: { o: 'umber', g: 'steel', m: 'slate' },
  },
  chair_front: {
    map: `..oooooooooo..
.onnnnnnnnnno.
.onNNNNNNNNno.
.onNnnnnnnNno.
.onnnnnnnnnno.
.oooooooooooo.
oNNNNNNNNNNNNo
oNnnnnnnnnnnNo
.oooooooooooo.
......oo......
....oooooo....
`,
    colors: { o: 'umber', n: 'plum', N: 'rose' },
  },
  chair_back: {
    map: `..oooooooooo..
.oNNNNNNNNNNo.
.oNnnnnnnnnNo.
.oNnnnnnnnnNo.
.oNnnnnnnnnNo.
..oooooooooo..
......oo......
....oooooo....
`,
    colors: { o: 'umber', n: 'plum', N: 'rose' },
  },
  printer: {
    map: `...oooooooooo...
...oWWWWWWWWo...
.oooooooooooooo.
.oMMMMMMMMMMMMo.
.oMllllllllllMo.
.oMlGlllllllMMo.
.oMMMMMMMMMMMMo.
.oNNNNNNNNNNNNo.
.oNooooooooooNo.
.oNoWLLWLLLWoNo.
.oNoWWWWWWWWoNo.
.oNNNNNNNNNNNNo.
.oooooooooooooo.
`,
    colors: {
      o: 'umber',
      W: 'white',
      M: 'mist',
      l: 'white',
      G: 'leaf',
      N: 'steel',
      L: 'slate',
    },
  },
  tray: {
    map: `oooooooooooooooooooo
oWWWWWWWWWWWWWWWWWWo
oWLLLLLLLLLWWWWWWWWo
ouuuuuuuuuuuuuuuuuuo
oFFFFFFFFFFFFFFFFFFo
oooooooooooooooooooo
`,
    colors: { o: 'umber', W: 'white', L: 'mist', u: 'tan', F: 'fawn' },
  },
  tray_empty: {
    map: `oooooooooooooooooooo
o..................o
ouuuuuuuuuuuuuuuuuuo
oFFFFFFFFFFFFFFFFFFo
oooooooooooooooooooo
`,
    colors: { o: 'umber', u: 'tan', F: 'fawn' },
  },
  envelope: {
    map: `ooooooooooo
oWWWWWWWWWo
olWWWWWWWlo
oWlWWWWWlWo
oWWllRllWWo
oWWWWWWWWWo
ooooooooooo
`,
    colors: { o: 'umber', W: 'white', l: 'mist', R: 'coral' },
  },
  bang: {
    map: `.oooooooo.
oYYYYYYYYo
oYYYooYYYo
oYYYooYYYo
oYYYooYYYo
oYYYooYYYo
oYYYYYYYYo
oYYYooYYYo
oYYYooYYYo
oYYYYYYYYo
.oooYYoooo
...oYo....
....o.....
`,
    colors: { o: 'umber', Y: 'amber' },
  },
  smoke: {
    map: `.....llll.....
...llWWWll....
..lWWWWWWll...
.lWWllWWWWll..
.lWWWWWlWWWl..
..llWWWWWWl...
....llWWll....
......ll......
`,
    colors: { l: 'steel', W: 'mist' },
  },
  mug: {
    map: `ooooo..
oWWWoo.
oRRRoWo
oWWWoWo
oWWWoo.
.ooo...
`,
    colors: { o: 'umber', W: 'white', R: 'coral' },
  },
  lamp_off: {
    map: `...oooo...
..oAAAAo..
.oAAAAAAo.
oAAAAAAAAo
.oooooooo.
.....oo...
....oo....
....oo....
..oooooo..
`,
    colors: { o: 'umber', A: 'slate' },
  },
  lamp_on: {
    map: `...oooo...
..oAAAAo..
.oAAAAAAo.
oAAAAAAAAo
.oyyyyyyo.
.yyyoyyyy.
.yy.oo.yy.
....oo....
..oooooo..
`,
    colors: { o: 'umber', A: 'amber', y: 'lemon' },
  },
  coffee: {
    map: `.oooooooooo.
oNNNNNNNNNNo
oNkkkkkkkkNo
oNkGkkkkkkNo
oNNNNNNNNNNo
oNNoooooNNNo
oNNoMMMoNNNo
oNNoWWWoNNNo
oNNNNNNNNNNo
oooooooooooo
`,
    colors: {
      o: 'umber',
      N: 'dusk',
      k: 'ink',
      G: 'cyan',
      M: 'brown',
      W: 'white',
    },
  },
  clock: {
    map: `..oooooo..
.oWWWWWWo.
oWWWoWWWWo
oWWWoWWWWo
oWWWoooWWo
oWWWWWWWWo
.oWWWWWWo.
..oooooo..
`,
    colors: { o: 'umber', W: 'white' },
  },
  trash: {
    map: `.oooooooo.
oggggggggo
.oNNNNNNo.
.oNmNNmNo.
.oNmNNmNo.
.oNmNNmNo.
.oNNNNNNo.
..oooooo..
`,
    colors: { o: 'umber', g: 'mist', N: 'steel', m: 'slate' },
  },
  box: {
    map: `.oooooooooo.
oTTTTuTTTTTo
oTTTTuTTTTTo
ouuuuuuuuuuo
oFFFFuFFFFFo
oFFFFuFFFFFo
oFFFFuFFFFFo
.oooooooooo.
`,
    colors: { o: 'umber', T: 'sand', u: 'tan', F: 'fawn' },
  },
  confetti: {
    map: `..R.....Y....b..
.....G.....p....
b..........R..Y.
....Y..b........
.p.......G....R.
......R.....b...
..G..........p..
.......Y........
`,
    colors: { R: 'coral', Y: 'lemon', b: 'sky', G: 'leaf', p: 'rose' },
  },
  corkboard: {
    map: `oooooooooooooooo
ouuuuuuuuuuuuuuo
ouWWuuuuyyyuuuuo
ouWWuuuuyyyuRRuo
ouuuuGGuuuuuRRuo
ouuuuGGuuuuuuuuo
ouuuuuuuuWWWuuuo
ouuuuuuuuWWWuuuo
ouuuuuuuuuuuuuuo
oooooooooooooooo
`,
    colors: {
      o: 'brown',
      u: 'clay',
      W: 'white',
      y: 'lemon',
      R: 'coral',
      G: 'leaf',
    },
  },
  jacket: {
    map: `..oooooooooo..
.oJJJJooJJJJo.
.oJjJJooJJjJo.
.oJjJJJJJJjJo.
..oooooooooo..
`,
    colors: { o: 'umber', J: 'slate', j: 'dusk' },
  },
  zz: {
    map: `oooo....
...o....
..o..ooo
.o.....o
oooo..o.
.....o..
.....ooo
`,
    colors: { o: 'slate' },
  },
} as const satisfies Record<string, PropMap>;

export type PropName = keyof typeof PROP_MAPS;

export function prop(name: PropName, recolor?: ColorMap): Raster {
  const { map, colors } = PROP_MAPS[name] as PropMap;
  const used = recolor ?? colors;
  if (!used) throw new Error(`Prop ${name} needs a colour map`);
  return rasterOf(sprite(map), used);
}

/** Monitor screens by tool category (M4_DESIGN §2.7), plus error and off. */
export const MONITOR_SCREENS = {
  off: ['dusk', 'slate'],
  edit: ['sky', 'white'],
  shell: ['orange', 'lemon'],
  read: ['cyan', 'white'],
  git: ['leaf', 'white'],
  network: ['rose', 'white'],
  other: ['mist', 'slate'],
  error: ['red', 'wine'],
} as const satisfies Record<string, readonly [ColorName, ColorName]>;
export type MonitorState = keyof typeof MONITOR_SCREENS;

export function monitor(state: MonitorState): Raster {
  const [S, L] = MONITOR_SCREENS[state];
  return prop(state === 'off' ? 'mon_off' : 'mon_on', {
    o: 'umber',
    k: 'ink',
    S,
    L,
  });
}
