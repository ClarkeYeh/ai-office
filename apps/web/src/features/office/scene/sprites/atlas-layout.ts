// The atlas arrangement: the only place that decides which sprite goes on which sheet and
// where. Frames of one sprite sit side by side in one row, so the scene can animate them by
// translating a strip inside a one-frame window with steps() (M4_PLAN §3.6).
import { ACCESSORIES, ROLES } from './accessories.ts';
import type { SignalColor } from './palette.ts';
import { MONITOR_SCREENS, type MonitorState } from './props.ts';
import { VENDORS } from './vendors.ts';

export const SHEETS = {
  characters: { file: 'characters.png', width: 160 },
  props: { file: 'props.png', width: 128 },
  fx: { file: 'fx.png', width: 544 },
} as const;
export type SheetName = keyof typeof SHEETS;

/** still: one frame. animation: frames played in a loop or once. states: pick one frame by value. */
export type SpriteKind = 'still' | 'animation' | 'states';

export interface SpriteSpec {
  readonly name: string;
  readonly sheet: SheetName;
  readonly w: number;
  readonly h: number;
  readonly frames: number;
  readonly kind: SpriteKind;
}

const POSES = [
  { pose: 'front', w: 16, h: 32, frames: 1, kind: 'still' },
  { pose: 'type', w: 16, h: 24, frames: 2, kind: 'animation' },
  { pose: 'upper', w: 16, h: 22, frames: 1, kind: 'still' },
  { pose: 'slump', w: 16, h: 24, frames: 1, kind: 'still' },
  { pose: 'idle', w: 16, h: 22, frames: 1, kind: 'still' },
  { pose: 'walk', w: 16, h: 32, frames: 4, kind: 'animation' },
] as const;
export type Pose = (typeof POSES)[number]['pose'];

/** Character sprite name, e.g. char.engineer.codex.default.type. */
export function charName(
  role: string,
  vendor: string,
  accessory: string,
  pose: Pose,
): string {
  return `char.${role}.${vendor}.${accessory}.${pose}`;
}

const still = (
  name: string,
  sheet: SheetName,
  w: number,
  h: number,
): SpriteSpec => ({
  name,
  sheet,
  w,
  h,
  frames: 1,
  kind: 'still',
});

export const SPRITES: readonly SpriteSpec[] = [
  // One row per role × vendor × accessory set, every pose of that look in one row.
  ...ROLES.flatMap((role) =>
    VENDORS.flatMap((vendor) =>
      ACCESSORIES.flatMap((accessory) =>
        POSES.map(({ pose, ...spec }) => ({
          name: charName(role, vendor, accessory, pose),
          sheet: 'characters' as const,
          ...spec,
        })),
      ),
    ),
  ),
  still('chair.front', 'props', 14, 11),
  still('chair.back', 'props', 14, 8),
  ...(Object.keys(MONITOR_SCREENS) as MonitorState[]).map((state) =>
    still(`monitor.${state}`, 'props', 14, 10),
  ),
  still('lamp.off', 'props', 10, 9),
  still('lamp.on', 'props', 10, 9),
  still('lamp.glow', 'props', 16, 4),
  still('tv.off', 'props', 42, 19),
  still('tv.meeting', 'props', 42, 19),
  still('door.closed', 'props', 26, 32),
  still('door.open', 'props', 26, 32),
  still('parcel', 'props', 12, 8),
  still('mug', 'props', 7, 6),
  still('paper.sheet', 'props', 10, 7),
  still('paper.note', 'props', 10, 7),
  { name: 'bang', sheet: 'fx', w: 10, h: 15, frames: 2, kind: 'animation' },
  { name: 'conveyor', sheet: 'fx', w: 108, h: 8, frames: 5, kind: 'animation' },
  { name: 'print', sheet: 'fx', w: 8, h: 6, frames: 3, kind: 'animation' },
  {
    name: 'coffee-pour',
    sheet: 'fx',
    w: 7,
    h: 9,
    frames: 3,
    kind: 'animation',
  },
  {
    name: 'paper-stack',
    sheet: 'fx',
    w: 10,
    h: 24,
    frames: 12,
    kind: 'states',
  },
  still('envelope', 'fx', 11, 7),
  still('smoke', 'fx', 14, 8),
  still('confetti', 'fx', 16, 8),
  still('leaf', 'fx', 4, 3),
  still('monitor-noise', 'fx', 10, 5),
];

/** Frame counts fixed by M4_DESIGN §3.3–§3.4 (the conveyor's 5 is one rib period). */
export const ANIMATION_FRAMES: Readonly<Record<string, number>> = {
  type: 2,
  walk: 4,
  bang: 2,
  print: 3,
  'coffee-pour': 3,
  conveyor: 5,
};

/** The only sprites that may contain each signal colour (M4_DESIGN §2.2). */
export const SIGNAL_ALLOWED: Readonly<Record<SignalColor, readonly string[]>> =
  {
    amber: ['lamp.on', 'bang'],
    red: ['monitor.error'],
  };

export interface AtlasSprite {
  readonly sheet: SheetName;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Frame i is at (x + i × w, y). */
  readonly frames: number;
  readonly kind: SpriteKind;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface AtlasJson {
  readonly version: 1;
  /** World pixels; height = top + rows × row + bottom, rows = ceil(maxParallel / 3). */
  readonly world: {
    readonly width: number;
    readonly topHeight: number;
    readonly rowHeight: number;
    readonly bottomHeight: number;
  };
  /** Background strips, stacked: top, rowFirst, rowExtra × (rows − 1), bottom. */
  readonly background: {
    readonly top: string;
    readonly rowFirst: string;
    readonly rowExtra: string;
    readonly bottom: string;
  };
  readonly sheets: Readonly<
    Record<
      SheetName,
      { readonly file: string; readonly width: number; readonly height: number }
    >
  >;
  readonly sprites: Readonly<Record<string, AtlasSprite>>;
  /**
   * Where the background leaves room for state sprites, in world pixels for one work row.
   * `desk` offsets are relative to (deskX[i], top of that work row); points at or below the
   * bottom strip move down by rowHeight × (rows − 1).
   */
  readonly placements: {
    readonly tv: Point;
    readonly door: Point;
    readonly lamp: Point;
    readonly lampGlow: Point;
    readonly inboxPaper: Point;
    readonly print: Point;
    readonly conveyor: Point;
    readonly counterParcel: Point;
    readonly pantryMug: Point;
    readonly deskX: readonly number[];
    readonly desk: {
      readonly monitor: Point;
      readonly chairTucked: Point;
      readonly chairPushed: Point;
      readonly stack: Point;
      readonly mug: Point;
      readonly note: Point;
    };
  };
}

/** Shelf packing in SPRITES order: a sprite's frames never wrap to the next row. */
export function packSprites(): {
  sprites: Record<string, AtlasSprite>;
  heights: Record<SheetName, number>;
} {
  const sprites: Record<string, AtlasSprite> = {};
  const cursor = Object.fromEntries(
    (Object.keys(SHEETS) as SheetName[]).map((sheet) => [
      sheet,
      { x: 0, y: 0, row: 0 },
    ]),
  ) as Record<SheetName, { x: number; y: number; row: number }>;
  for (const { name, sheet, w, h, frames, kind } of SPRITES) {
    const at = cursor[sheet];
    const width = w * frames;
    if (width > SHEETS[sheet].width)
      throw new Error(`${name} is wider than the ${sheet} sheet`);
    if (at.x + width > SHEETS[sheet].width) {
      at.y += at.row;
      at.x = 0;
      at.row = 0;
    }
    if (sprites[name]) throw new Error(`Duplicate sprite ${name}`);
    sprites[name] = { sheet, x: at.x, y: at.y, w, h, frames, kind };
    at.x += width;
    at.row = Math.max(at.row, h);
  }
  const heights = Object.fromEntries(
    Object.entries(cursor).map(([sheet, at]) => [sheet, at.y + at.row]),
  ) as Record<SheetName, number>;
  return { sprites, heights };
}
