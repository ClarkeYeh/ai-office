// Sprite source entry: renders every atlas sprite and background strip as pure RGBA.
// Only scripts/export-sprites runs this (in Node); the scene uses the exported assets/.
import {
  ACCESSORIES,
  ROLES,
  type AccessoryName,
  type Role,
} from './accessories.ts';
import {
  packSprites,
  SHEETS,
  SPRITES,
  type AtlasJson,
  type SheetName,
} from './atlas-layout.ts';
import { charBack, charFront, charWalk, type Look } from './characters.ts';
import {
  door,
  DESKS,
  DOOR_AT,
  extraRow,
  LAMP_GLOW_AT,
  lampGlow,
  paperNote,
  paperSheet,
  ROW_HEIGHT,
  TOP_HEIGHT,
  tv,
  TV_AT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  world,
  BOTTOM_HEIGHT,
  CONVEYOR_AT,
} from './floor.ts';
import {
  bang,
  coffeePour,
  conveyor,
  leaf,
  monitorNoise,
  paperStack,
  PRINT_AT,
  printing,
} from './fx.ts';
import { monitor, prop, type MonitorState } from './props.ts';
import { Raster } from './raster.ts';
import { VENDORS, type Vendor } from './vendors.ts';

export {
  ANIMATION_FRAMES,
  SHEETS,
  SIGNAL_ALLOWED,
  SPRITES,
} from './atlas-layout.ts';
export type {
  AtlasJson,
  AtlasSprite,
  SheetName,
  SpriteSpec,
} from './atlas-layout.ts';
export { colorName, PALETTE, rgba, SIGNAL_COLORS } from './palette.ts';
export type { ColorName, SignalColor } from './palette.ts';
export { Raster } from './raster.ts';
export { world, type Stage } from './floor.ts';

function characterFrames(look: Look, pose: string): Raster[] {
  switch (pose) {
    case 'front':
      return [charFront(look)];
    case 'type':
      return [charBack(look, 0), charBack(look, 1)];
    case 'upper':
      return [charFront(look, 22)];
    case 'slump':
      return [charBack(look, 0, 3)];
    case 'idle':
      return [charFront(look, 22, true)];
    case 'walk':
      return charWalk(look);
  }
  throw new Error(`Unknown pose ${pose}`);
}

const SINGLE: Readonly<Record<string, () => Raster | Raster[]>> = {
  'chair.front': () => prop('chair_front'),
  'chair.back': () => prop('chair_back'),
  'lamp.off': () => prop('lamp_off'),
  'lamp.on': () => prop('lamp_on'),
  'lamp.glow': lampGlow,
  'tv.off': () => tv(false),
  'tv.meeting': () => tv(true),
  'door.closed': () => door(false),
  'door.open': () => door(true),
  parcel: () => prop('box'),
  mug: () => prop('mug'),
  'paper.sheet': paperSheet,
  'paper.note': paperNote,
  bang,
  conveyor,
  print: printing,
  'coffee-pour': coffeePour,
  'paper-stack': paperStack,
  envelope: () => prop('envelope'),
  smoke: () => prop('smoke'),
  confetti: () => prop('confetti'),
  leaf,
  'monitor-noise': monitorNoise,
};

/** The frames of one atlas sprite. */
export function renderSprite(name: string): Raster[] {
  const parts = name.split('.');
  if (parts[0] === 'char' && parts.length === 5) {
    const [, role, vendor, accessory, pose] = parts as [
      string,
      Role,
      Vendor,
      AccessoryName,
      string,
    ];
    if (
      ROLES.includes(role) &&
      VENDORS.includes(vendor) &&
      ACCESSORIES.includes(accessory)
    )
      return characterFrames({ role, vendor, accessory }, pose);
  }
  if (parts[0] === 'monitor' && parts.length === 2)
    return [monitor(parts[1] as MonitorState)];
  const render = SINGLE[name];
  if (!render) throw new Error(`No art for sprite ${name}`);
  const out = render();
  return Array.isArray(out) ? out : [out];
}

export interface SpriteAssets {
  /** Output file name -> raster, for every PNG in assets/. */
  readonly images: ReadonlyMap<string, Raster>;
  readonly atlas: AtlasJson;
}

/** Renders every sheet and background strip, and the atlas that describes them. */
export function buildAssets(): SpriteAssets {
  const { sprites, heights } = packSprites();
  const sheets = new Map<SheetName, Raster>(
    (Object.keys(SHEETS) as SheetName[]).map((sheet) => [
      sheet,
      new Raster(SHEETS[sheet].width, heights[sheet]),
    ]),
  );
  for (const spec of SPRITES) {
    const frames = renderSprite(spec.name);
    const at = sprites[spec.name];
    const sheet = sheets.get(spec.sheet);
    if (!at || !sheet) throw new Error(`Unplaced sprite ${spec.name}`);
    if (frames.length !== spec.frames)
      throw new Error(
        `${spec.name}: ${frames.length} frames, layout says ${spec.frames}`,
      );
    frames.forEach((frame, i) => {
      if (frame.width !== spec.w || frame.height !== spec.h)
        throw new Error(
          `${spec.name}: frame ${i} is ${frame.width}×${frame.height}, layout says ${spec.w}×${spec.h}`,
        );
      sheet.draw(frame, at.x + i * spec.w, at.y);
    });
  }
  const floor = world(null);
  const background = {
    top: 'bg-top.png',
    rowFirst: 'bg-row-first.png',
    rowExtra: 'bg-row-extra.png',
    bottom: 'bg-bottom.png',
  } as const;
  const images = new Map<string, Raster>([
    [background.top, floor.crop(0, 0, WORLD_WIDTH, TOP_HEIGHT)],
    [background.rowFirst, floor.crop(0, TOP_HEIGHT, WORLD_WIDTH, ROW_HEIGHT)],
    [background.rowExtra, extraRow()],
    [
      background.bottom,
      floor.crop(0, TOP_HEIGHT + ROW_HEIGHT, WORLD_WIDTH, BOTTOM_HEIGHT),
    ],
    ...[...sheets].map(
      ([sheet, raster]) => [SHEETS[sheet].file, raster] as [string, Raster],
    ),
  ]);
  if (TOP_HEIGHT + ROW_HEIGHT + BOTTOM_HEIGHT !== WORLD_HEIGHT)
    throw new Error('Strip heights');
  const atlas: AtlasJson = {
    version: 1,
    world: {
      width: WORLD_WIDTH,
      topHeight: TOP_HEIGHT,
      rowHeight: ROW_HEIGHT,
      bottomHeight: BOTTOM_HEIGHT,
    },
    background,
    sheets: Object.fromEntries(
      (Object.keys(SHEETS) as SheetName[]).map((sheet) => [
        sheet,
        {
          file: SHEETS[sheet].file,
          width: SHEETS[sheet].width,
          height: heights[sheet],
        },
      ]),
    ) as AtlasJson['sheets'],
    sprites,
    placements: {
      tv: TV_AT,
      door: DOOR_AT,
      lamp: { x: 293, y: 56 },
      lampGlow: LAMP_GLOW_AT,
      inboxPaper: { x: 305, y: 66 },
      print: PRINT_AT,
      conveyor: CONVEYOR_AT,
      counterParcel: { x: 289, y: 124 },
      pantryMug: { x: 30, y: 180 },
      deskX: DESKS,
      desk: {
        monitor: { x: 13, y: 3 },
        chairTucked: { x: 13, y: 33 },
        chairPushed: { x: 18, y: 39 },
        stack: { x: 29, y: 1 },
        mug: { x: 3, y: 15 },
        note: { x: 3, y: 14 },
      },
    },
  };
  return { images, atlas };
}
