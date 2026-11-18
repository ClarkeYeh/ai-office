import type { ReadModel } from '@ai-office/projection';
import type {
  Accessory,
  AnchorId,
  Point,
  Rect,
  RoomId,
  SeatPlace,
} from './types.js';

// Fixed floor plan (M4_DESIGN §3.1, D10) and the stable desk / accessory
// assignment (§2.5). Coordinates follow the v3 sketch generator
// (tools/sprites-src scene3.py); everything at y ≥ 168 moves down 64 px for each
// desk row past the first.

export const WORLD_WIDTH = 352;
export const BASE_HEIGHT = 224;
export const ROW_HEIGHT = 64;
export const DESKS_PER_ROW = 3;
/** Everything from the pantry/lounge band down shifts with extra desk rows. */
const SHIFT_FROM_Y = 168;
/** §2.6 paper stack: one sheet per 50k budget tokens, at most 12. */
export const TOKENS_PER_SHEET = 50_000;
export const MAX_SHEETS = 12;

export const sheetsFor = (tokens: number): number =>
  Math.min(MAX_SHEETS, Math.ceil(Math.max(0, tokens) / TOKENS_PER_SHEET));

export function rowsFor(maxParallel: number, highestDesk = -1): number {
  return Math.max(
    1,
    Math.ceil(maxParallel / DESKS_PER_ROW),
    Math.floor(highestDesk / DESKS_PER_ROW) + 1,
  );
}

export const worldSize = (rows: number) => ({
  width: WORLD_WIDTH,
  height: BASE_HEIGHT + ROW_HEIGHT * (rows - 1),
  rows,
});

const shiftY = (y: number, rows: number) =>
  y >= SHIFT_FROM_Y ? y + ROW_HEIGHT * (rows - 1) : y;
const at = (x: number, y: number, rows: number): Point => ({
  x,
  y: shiftY(y, rows),
});

export type RoomPlan = { id: RoomId; rect: Rect; plate: Point };

export function roomPlan(rows: number): RoomPlan[] {
  const extra = ROW_HEIGHT * (rows - 1);
  return [
    {
      id: 'meeting',
      rect: { x: 0, y: 32, w: 112, h: 64 },
      plate: at(6, 86, rows),
    },
    {
      id: 'lead',
      rect: { x: 116, y: 32, w: 56, h: 64 },
      plate: at(120, 86, rows),
    },
    {
      id: 'hall',
      rect: { x: 176, y: 32, w: 80, h: 72 },
      plate: at(196, 94, rows),
    },
    {
      id: 'yours',
      rect: { x: 260, y: 32, w: 92, h: 64 },
      plate: at(262, 86, rows),
    },
    {
      id: 'desks',
      rect: { x: 0, y: 104, w: 184, h: ROW_HEIGHT * rows },
      plate: at(4, 104, rows),
    },
    {
      id: 'counter',
      rect: { x: 184, y: 104, w: 168, h: 64 },
      plate: at(282, 142, rows),
    },
    {
      id: 'pantry',
      rect: { x: 0, y: 168 + extra, w: 112, h: 56 },
      plate: at(4, 170, rows),
    },
    {
      id: 'lounge',
      rect: { x: 112, y: 168 + extra, w: 240, h: 56 },
      plate: at(116, 170, rows),
    },
  ];
}

/** Your office plus the hall door: the only lit area during a stage gate hush. */
export const LIT_AREA: Rect = { x: 260, y: 32, w: 92, h: 72 };

// Desks: 40×16, x = 8 + 56i, first row top at y 116.
export const deskOrigin = (desk: number): Point => ({
  x: 8 + 56 * (desk % DESKS_PER_ROW),
  y: 116 + ROW_HEIGHT * Math.floor(desk / DESKS_PER_ROW),
});
/** Seated-from-behind sprite (16×24) at a desk. */
export const deskSeat = (desk: number): Point => {
  const d = deskOrigin(desk);
  return { x: d.x + 12, y: d.y + 8 };
};
export const deskPlate = (desk: number): Point => {
  const d = deskOrigin(desk);
  return { x: d.x + 20, y: d.y + 34 };
};
export const deskStack = (desk: number): Point => {
  const d = deskOrigin(desk);
  return { x: d.x + 29, y: d.y + 12 };
};
export const deskParcel = (desk: number): Point => {
  const d = deskOrigin(desk);
  return { x: d.x + 3, y: d.y + 2 };
};

/** Meeting room: five chairs around the table, the facilitator stands at the head. */
export const MEETING_CHAIRS: readonly Point[] = [
  { x: 25, y: 36 },
  { x: 73, y: 36 },
  { x: 49, y: 36 },
  { x: 31, y: 72 },
  { x: 63, y: 72 },
];
export const MEETING_FACILITATOR: Point = { x: 94, y: 40 };
export const meetingPlate = (p: Point): Point => ({ x: p.x + 8, y: p.y + 25 });

export const LEAD_SEAT: Point = { x: 136, y: 38 };
export const LEAD_PLATE: Point = { x: 145, y: 74 };
export const COUNTER_SEAT: Point = { x: 306, y: 106 };
export const COUNTER_PLATE: Point = { x: 316, y: 160 };
export const YOUR_DESK_PLATE: Point = { x: 312, y: 82 };
const LOUNGE_ORIGIN: Point = { x: 176, y: 172 };
export const loungeSeat = (index: number, rows: number): Point =>
  at(LOUNGE_ORIGIN.x + 18 * (index % 4), LOUNGE_ORIGIN.y, rows);

/** Merge queue on the conveyor: slot 0 waits next to the counter. */
export const queueSlot = (slot: number): Point => ({
  x: 266 - 14 * slot,
  y: 144,
});
export const COUNTER_PARCEL: Point = { x: 289, y: 124 };

export function fixedAnchors(rows: number): Record<string, Point> {
  return {
    entrance: at(148, 186, rows),
    inbox: { x: 206, y: 64 },
    printer: { x: 180, y: 58 },
    'your-desk': { x: 305, y: 60 },
    counter: COUNTER_PARCEL,
    hopper: { x: 168, y: 144 },
    cart: at(310, 196, rows),
    door: { x: 318, y: 8 },
    'lead-desk': LEAD_SEAT,
  } satisfies Partial<Record<AnchorId, Point>>;
}

// -- stable desk and accessory assignment -----------------------------------

const ACCESSORIES: readonly Accessory[] = [
  'cyan',
  'leaf',
  'tan',
  'plum',
  'steel',
];
const TERMINAL = new Set(['merged', 'skipped']);
const ms = (iso: string | undefined) =>
  iso === undefined ? 0 : Date.parse(iso);

/** FNV-1a, 32 bit: deterministic across runtimes. */
export function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

type Seat = ReadModel['seats'][number];
type Holder = {
  seat: Seat;
  itemKey: string;
  start: number;
  /** When the desk became free, or `Infinity` while the item still holds it. */
  freedAt: number;
};

const alive = (a: Seat['attempts'][number]) =>
  a.endedAt === undefined && !a.released;

/**
 * Lower bound of the moment a finished item let go of its desk: the read model
 * keeps no terminal timestamp, so take the latest fact recorded about the item
 * (attempt ends, its artifacts, its PR status — the merge itself — and its
 * exception gate decisions). `Infinity` while the item can still come back.
 */
function freedAt(rm: ReadModel, seat: Seat, itemKey: string): number {
  const item = rm.workItems.find((w) => w.key === itemKey);
  if (!item || !TERMINAL.has(item.status) || seat.attempts.some(alive))
    return Infinity;
  const times = [
    ...seat.attempts.map((a) => ms(a.endedAt ?? a.startedAt)),
    ...rm.artifacts.filter((a) => a.itemKey === itemKey).map((a) => ms(a.at)),
    ...rm.prs.filter((p) => p.itemKey === itemKey).map((p) => ms(p.updatedAt)),
    ...rm.gates
      .filter(
        (g) => g.content.type === 'exception' && g.content.itemKey === itemKey,
      )
      .flatMap((g) => [ms(g.decision?.at), ms(g.closedAt)]),
  ];
  return Math.max(...times);
}

export type DeskAssignment = {
  /** Desk index per item seat id. */
  desks: Map<string, number>;
  accessories: Map<string, Accessory>;
  /** Desks still held right now (by an item that is not finished). */
  held: Set<number>;
  /** Every desk an item has sat at so far. */
  used: Set<number>;
  /** Latest seat to sit at each desk (paper stacks stay with the desk). */
  lastSeatAt: Map<number, string>;
};

/**
 * Desk choice shared by dispatched items and reservations: a desk nobody has used
 * yet comes first (so a reserved desk is still free when its item is dispatched),
 * then the lowest freed desk within `capacity`, then a new desk past it.
 */
export function pickDesk(
  taken: ReadonlySet<number>,
  used: ReadonlySet<number>,
  capacity: number,
): number {
  for (let desk = 0; desk < capacity; desk++)
    if (!taken.has(desk) && !used.has(desk)) return desk;
  for (let desk = 0; desk < capacity; desk++) if (!taken.has(desk)) return desk;
  let desk = capacity;
  while (taken.has(desk)) desk++;
  return desk;
}

/**
 * Replays implement-stage item seats in order of their first worker attempt
 * (`startedAt`, then `itemKey`); each takes a desk (`pickDesk`) not held at that
 * moment. A desk is freed once its item is merged or skipped and its attempts
 * ended, so an `itemKey` keeps one desk and one accessory colour for the whole
 * workflow (rework and retries included). Only immutable facts (start times, end
 * times) decide earlier seats, so later events never move a seated item; and the
 * function is pure in the read model, so replaying to any seq gives the floor the
 * live view showed at that seq.
 */
export function assignDesks(rm: ReadModel, capacity: number): DeskAssignment {
  const holders: Holder[] = rm.seats
    .flatMap((seat) => {
      const workers = seat.attempts.filter((a) => a.purpose === 'worker');
      if (seat.itemKey === undefined || workers.length === 0) return [];
      return [
        {
          seat,
          itemKey: seat.itemKey,
          start: Math.min(...workers.map((a) => ms(a.startedAt))),
          freedAt: freedAt(rm, seat, seat.itemKey),
        },
      ];
    })
    .sort((a, b) => a.start - b.start || compare(a.itemKey, b.itemKey));

  const desks = new Map<string, number>();
  const accessories = new Map<string, Accessory>();
  const lastSeatAt = new Map<number, string>();
  const used = new Set<number>();
  const placed: Holder[] = [];
  for (const holder of holders) {
    const busy = placed.filter((p) => p.freedAt >= holder.start);
    const taken = new Set(busy.map((p) => desks.get(p.seat.seatId)!));
    const desk = pickDesk(taken, used, capacity);
    desks.set(holder.seat.seatId, desk);
    lastSeatAt.set(desk, holder.seat.seatId);
    used.add(desk);
    accessories.set(
      holder.seat.seatId,
      accessoryFor(
        holder,
        placed.some((p) => p.seat.role === holder.seat.role),
        new Set(
          busy
            .filter((p) => p.seat.role === holder.seat.role)
            .map((p) => accessories.get(p.seat.seatId)),
        ),
      ),
    );
    placed.push(holder);
  }
  const held = new Set(
    placed
      .filter((p) => p.freedAt === Infinity)
      .map((p) => desks.get(p.seat.seatId)!),
  );
  return { desks, accessories, held, used, lastSeatAt };
}

/**
 * §2.5: the role's first instance wears the default colour; later ones take
 * `hash(itemKey) mod 5`, moving on past colours worn by instances present at the
 * same time.
 */
function accessoryFor(
  holder: Holder,
  hadEarlier: boolean,
  worn: ReadonlySet<Accessory | undefined>,
): Accessory {
  if (!hadEarlier) return 'default';
  const first = hashKey(holder.itemKey) % ACCESSORIES.length;
  for (let i = 0; i < ACCESSORIES.length; i++) {
    const candidate = ACCESSORIES[(first + i) % ACCESSORIES.length]!;
    if (!worn.has(candidate)) return candidate;
  }
  return ACCESSORIES[first]!;
}

/**
 * Desks for approved, undispatched items, in work-item order, within `capacity`:
 * the desk each would get if dispatched now, given the earlier reservations.
 */
export function reserveDesks(
  itemKeys: readonly string[],
  assignment: Pick<DeskAssignment, 'held' | 'used'>,
  capacity: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set(assignment.held);
  const used = new Set(assignment.used);
  for (const key of itemKeys) {
    const desk = pickDesk(taken, used, capacity);
    if (desk >= capacity) break;
    out.set(key, desk);
    taken.add(desk);
    used.add(desk);
  }
  return out;
}

/**
 * Meeting chairs: participants in order of their first participant attempt, then
 * role; the facilitator stands at the head of the table.
 */
export function assignMeetingChairs(rm: ReadModel): Map<string, number> {
  const participants = rm.seats
    .flatMap((seat) => {
      const attempts = seat.attempts.filter((a) => a.purpose === 'participant');
      if (attempts.length === 0) return [];
      return [
        { seat, start: Math.min(...attempts.map((a) => ms(a.startedAt))) },
      ];
    })
    .sort((a, b) => a.start - b.start || compare(a.seat.role, b.seat.role));
  return new Map(
    participants.map((p, i) => [p.seat.seatId, i % MEETING_CHAIRS.length]),
  );
}

/** Where a figure goes, by the purpose of its current (or last) attempt. */
export function placeFor(
  purpose: Seat['attempts'][number]['purpose'] | undefined,
  ondemand: 'oncall' | 'merge' | undefined,
  hasDesk: boolean,
): SeatPlace {
  if (hasDesk && purpose === 'worker') return 'desk';
  if (ondemand === 'merge' || purpose === 'integrator') return 'counter';
  if (purpose === 'facilitator' || purpose === 'participant') return 'meeting';
  if (purpose === 'planner' || purpose === 'oncall') return 'lead';
  return hasDesk ? 'desk' : 'lounge';
}

const compare = (a: string, b: string) => Number(a > b) - Number(a < b);
