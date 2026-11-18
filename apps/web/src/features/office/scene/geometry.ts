import type {
  Anchor,
  AnchorId,
  OfficeSeat,
  OfficeViewModel,
  Point,
} from '../model/index.js';

// Pure scene geometry: integer scale, anchor resolution, which character frame a
// seat shows, stepped motion paths and the fixed easter-egg props. World pixels
// at 1× throughout; components multiply by the integer scale.

export const WORLD_WIDTH = 352;
export const MIN_SCALE = 2;
/** Fixed floor rows that move down with each extra desk row (layout.ts). */
const SHIFT_FROM_Y = 168;
const ROW_HEIGHT = 64;

/** M4_DESIGN §2.1: `floor(available / 352)`, at least 2×. */
export function sceneScale(availableWidth: number): number {
  return Math.max(MIN_SCALE, Math.floor(availableWidth / WORLD_WIDTH));
}

/** D13: a room plate zooms to the next integer multiple (3× → 6×). */
export const ZOOM_FACTOR = 2;

export const shiftY = (y: number, rows: number): number =>
  y >= SHIFT_FROM_Y ? y + ROW_HEIGHT * (rows - 1) : y;

export function anchorKey(anchor: Anchor): AnchorId {
  switch (anchor.kind) {
    case 'seat':
    case 'meeting':
      return `${anchor.kind}:${anchor.seatId}`;
    case 'workitem':
      return `workitem:${anchor.itemKey}`;
    default:
      return anchor.kind;
  }
}

/** A missing anchor means the target is not on the floor: skip the effect. */
export function resolveAnchor(
  vm: Pick<OfficeViewModel, 'anchors'>,
  anchor: Anchor,
): Point | undefined {
  return vm.anchors[anchorKey(anchor)];
}

/** The seat id an anchor stands for, if it names one (directly or by item). */
export function seatOfAnchor(
  vm: Pick<OfficeViewModel, 'seats'>,
  anchor: Anchor,
): OfficeSeat | undefined {
  if (anchor.kind === 'seat' || anchor.kind === 'meeting')
    return vm.seats.find((s) => s.seatId === anchor.seatId);
  if (anchor.kind === 'workitem')
    return vm.seats.find((s) => s.itemKey === anchor.itemKey);
  return undefined;
}

// -- characters --------------------------------------------------------------

export type Facing = 'back' | 'behind-desk' | 'standing';
export type CharacterFrame =
  'front' | 'type' | 'upper' | 'slump' | 'idle' | 'walk';

export const ROLES = [
  'lead',
  'pm',
  'architect',
  'engineer',
  'integrator',
] as const;

export function characterSprite(
  seat: Pick<OfficeSeat, 'role' | 'vendor' | 'accessory'>,
  frame: CharacterFrame,
): string {
  const role = (ROLES as readonly string[]).includes(seat.role)
    ? seat.role
    : 'engineer';
  return `char.${role}.${seat.vendor ?? 'claude-code'}.${seat.accessory}.${frame}`;
}

/** Desks and the near meeting chairs face the table (back to the camera). */
export function facingOf(seat: Pick<OfficeSeat, 'place' | 'chair'>): Facing {
  switch (seat.place) {
    case 'desk':
      return 'back';
    case 'meeting':
      if (seat.chair === 'facilitator') return 'standing';
      return typeof seat.chair === 'number' &&
        (seat.chair === 2 || seat.chair === 3)
        ? 'back'
        : 'behind-desk';
    case 'lead':
    case 'counter':
      return 'behind-desk';
    case 'lounge':
      return 'standing';
  }
}

export type Figure = {
  frame: CharacterFrame;
  /** Offset from the seat's (x, y), which is the top of a seated sprite. */
  dx: number;
  dy: number;
  /** Two-frame typing loop (§3.3); only while working at a desk. */
  animated: boolean;
  smoke: boolean;
  bang: boolean;
};

/**
 * §2.6: which frame a seat shows. Seated sprites are 24 px tall (22 for the
 * front upper body); standing ones are 32, drawn so their feet stay put.
 */
export function figureOf(seat: OfficeSeat): Figure | null {
  if (seat.pose === 'away') return null;
  const facing = facingOf(seat);
  const smoke = seat.pose === 'error';
  const bang = seat.pose === 'needs-you';
  const still = (frame: CharacterFrame, dy = 0): Figure => ({
    frame,
    dx: 0,
    dy,
    animated: false,
    smoke,
    bang,
  });
  if (facing === 'standing') return still('front');
  if (facing === 'behind-desk')
    return still(seat.pose === 'idle' ? 'idle' : 'upper');
  switch (seat.pose) {
    case 'needs-you':
      return still('front', -8);
    case 'error':
      return still('slump');
    case 'idle':
      return still('idle', 2);
    case 'working':
      return { ...still('type'), animated: seat.place === 'desk' };
  }
}

// -- motion -------------------------------------------------------------------

/** Walk-in goes up the corridor first, walk-out leaves its row first. */
export function walkPath(
  from: Point,
  to: Point,
  verticalFirst: boolean,
): Point[] {
  const corner = verticalFirst
    ? { x: from.x, y: to.y }
    : { x: to.x, y: from.y };
  return [from, corner, to];
}

const dist = (a: Point, b: Point) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

/** Positions every `step` px along an axis-aligned or straight polyline, rounded. */
export function steppedPoints(points: readonly Point[], step: number): Point[] {
  const out: Point[] = [];
  const push = (p: Point) => {
    const q = { x: Math.round(p.x), y: Math.round(p.y) };
    const last = out.at(-1);
    if (!last || last.x !== q.x || last.y !== q.y) out.push(q);
  };
  if (points.length > 0) push(points[0]!);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(length / step));
    for (let k = 1; k <= n; k++)
      push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** §3.3: walking shows 8 frames a second; at most 4 s across the floor. */
export const WALK_FPS = 8;
const WALK_STEP = 6;
const WALK_MAX_MS = 4000;
export function walkSteps(path: readonly Point[]): Point[] {
  const length = path
    .slice(1)
    .reduce((sum, p, i) => sum + dist(path[i]!, p), 0);
  const maxSteps = (WALK_MAX_MS / 1000) * WALK_FPS;
  const step = Math.max(WALK_STEP, Math.ceil(length / maxSteps));
  return steppedPoints(path, step);
}

/** §3.3 envelope: two or more legs in 600–900 ms. */
export function envelopeDuration(legs: number): number {
  return Math.min(900, Math.max(600, 300 * legs));
}

// -- fixed props: easter eggs and windows (scene3.py world()) -----------------

/** Plants (16×14) in background order; rows shift those in the bottom band. */
export function plants(rows: number): Point[] {
  return [
    { x: 94, y: 78 },
    { x: 156, y: 34 },
    { x: 236, y: 34 },
    { x: 336, y: 78 },
    { x: 164, y: 102 },
    { x: 92, y: 200 },
    { x: 118, y: 196 },
  ].map((p) => ({ x: p.x, y: shiftY(p.y, rows) }));
}
export const PLANT_SIZE = { w: 16, h: 14 } as const;
export const CLOCK = { x: 152, y: 8, w: 10, h: 8 } as const;
export const coffeeMachine = (rows: number) =>
  ({ x: 12, y: shiftY(172, rows), w: 12, h: 10 }) as const;
export const WHITEBOARD = { x: 182, y: 5, w: 52, h: 17 } as const;
export const INBOX_TRAY = { x: 204, y: 62, w: 24, h: 30 } as const;
export const YOUR_DESK = { x: 290, y: 52, w: 44, h: 26 } as const;
/** Window glass (each pane beside the mullion) of the four back-wall windows. */
export const WINDOW_PANES: readonly {
  x: number;
  y: number;
  w: number;
  h: number;
}[] = [6, 86, 122, 266].flatMap((x) => [
  { x: x + 2, y: 7, w: 9, h: 11 },
  { x: x + 12, y: 7, w: 8, h: 11 },
]);

export type Sky = 'day' | 'evening' | 'night';
/** §3.4: day sky / evening clay / night dusk, from the local hour. */
export function skyAt(hour: number): Sky {
  if (hour >= 6 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'evening';
  return 'night';
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
