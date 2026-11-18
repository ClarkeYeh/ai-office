import type { AttemptView } from '@ai-office/contracts/api';
import type { AttemptState, WorkItemStatus } from '@ai-office/contracts/events';
import type { Anchor } from './effect-types.js';
import type { Translate } from './messages.js';

// View-model contract between the office model (M4-T5), effects (M4-T6), the scene
// (M4-T8) and the office page (M4-T9). All coordinates are world pixels at 1×
// (the scene multiplies by the integer scale); strings are already translated.

export type SelectorArgs = {
  /** Epoch milliseconds from the app ticker; selectors never read the clock. */
  now: number;
  t: Translate;
  selectedSeatId?: string | null;
};

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** §2.6 seat states, first match wins: needs-you › error › working › idle › away. */
export type Pose = 'needs-you' | 'error' | 'working' | 'idle' | 'away';
/** §2.7 screen: tool colours while working, `dark` when idle, `off` when away. */
export type Screen =
  | 'off'
  | 'dark'
  | 'error'
  | 'read'
  | 'edit'
  | 'shell'
  | 'git'
  | 'network'
  | 'other';
/** §2.5 accessory slots; `default` is the role's own colour. Never amber or red. */
export type Accessory = 'default' | 'cyan' | 'leaf' | 'tan' | 'plum' | 'steel';
export type Vendor = AttemptView['agent'];
export type VendorBadge = 'CC' | 'CX';
/** Where the figure stands: desks, meeting chairs, the lead's office or the counter. */
export type SeatPlace = 'desk' | 'meeting' | 'lead' | 'counter' | 'lounge';
export type NameplateTone = 'plain' | 'need' | 'error' | 'selected';

export type Nameplate = {
  title: string;
  subtitle?: string;
  badge?: VendorBadge;
  tone: NameplateTone;
  /** Anchor point of the plate (centre of its top edge). */
  x: number;
  y: number;
};

export type RoomId =
  | 'meeting'
  | 'lead'
  | 'hall'
  | 'yours'
  | 'desks'
  | 'counter'
  | 'pantry'
  | 'lounge';

type KeyedAnchor = Extract<Anchor, { kind: 'seat' | 'workitem' | 'meeting' }>;

/**
 * Keys of `OfficeViewModel.anchors`. Every effect `Anchor` (effect-types.ts) has
 * one: a fixed kind is its own key; keyed kinds are `seat:<seatId>`,
 * `workitem:<itemKey>` (the item's desk, seated or reserved) and
 * `meeting:<seatId>` (that seat's meeting chair). `desk:<n>` and `lead-desk`
 * are extra points for the scene. A missing key means the target is not on the
 * floor; the scene then skips the effect.
 */
export type AnchorId =
  | Exclude<Anchor['kind'], KeyedAnchor['kind']>
  | `${KeyedAnchor['kind']}:${string}`
  | `desk:${number}`
  | 'lead-desk';

export type OfficeSeat = {
  seatId: string;
  /** Current attempt; null before the first spawn. */
  attemptId: string | null;
  role: string;
  itemKey?: string;
  vendor: Vendor | null;
  accessory: Accessory;
  pose: Pose;
  screen: Screen;
  lamp: 'off' | 'amber';
  place: SeatPlace;
  /** Desk index (row-major, 3 per row) for desk seats. */
  desk?: number;
  /** Meeting chair index for meeting seats; `facilitator` stands at the head. */
  chair?: number | 'facilitator';
  /** Top-left of the character sprite. */
  x: number;
  y: number;
  nameplate: Nameplate;
  ariaLabel: string;
  testId: string;
  needsYou: boolean;
  error: boolean;
  degraded: boolean;
  ondemand?: 'oncall' | 'merge';
  selected: boolean;
  /** Raw state for `data-state` in tests and e2e. */
  state: AttemptState | null;
};

/** A desk kept for an approved item that has not been dispatched yet. */
export type ReservedDesk = {
  itemKey: string;
  desk: number;
  x: number;
  y: number;
  blockedBy: string[];
  nameplate: Nameplate;
  ariaLabel: string;
  testId: string;
};

export type Room = {
  id: RoomId;
  rect: Rect;
  label: string;
  plate: Point;
  ariaLabel: string;
  testId: string;
};

export type Whiteboard = {
  title: string;
  lines: string[];
  ariaLabel: string;
  testId: string;
};

export type InboxItem = {
  artifactId: string;
  kind: 'issue' | 'pr';
  number: number;
  url?: string;
  label: string;
  testId: string;
};

export type NeedKind = 'gate' | 'question' | 'seat';
export type Need = {
  id: string;
  kind: NeedKind;
  gateId?: string;
  questionId?: string;
  seatId?: string;
  title: string;
  subtitle: string;
  /** Route to open: `/gates/:id`, `/questions/:id`, or the seat (selection). */
  href?: string;
  since: string;
  ariaLabel: string;
  testId: string;
};

export type YourDesk = {
  lamp: 'off' | 'amber';
  paper: boolean;
  bang: boolean;
  nameplate: Nameplate;
  ariaLabel: string;
  testId: string;
};

export type ParcelPlace = 'queue' | 'counter' | 'desk';
export type Parcel = {
  itemKey: string;
  pr?: number;
  place: ParcelPlace;
  /** Queue slot (0 = next to the counter) or desk index. */
  slot: number;
  x: number;
  y: number;
};

export type Conveyor = {
  open: boolean;
  queue: string[];
  current?: string;
  label: string;
  merged: number;
  cartLabel: string;
};

export type PaperStack = { desk: number; sheets: number; x: number; y: number };

export type Hush = {
  active: boolean;
  gateId?: string;
  /** The lit area (your office); everything else gets the 42% ink overlay. */
  lit: Rect;
  label: string;
};

export type Door = { open: boolean; label: string };

export type Usage = {
  totalTokens: number;
  label: string;
  sheets: number;
  budgetDisabled: boolean;
  budgetLabel?: string;
};

export type OfficeViewModel = {
  workflowId: string;
  world: { width: number; height: number; rows: number };
  /** Stage kind the floor is showing (drives props such as the meeting TV). */
  stageKind: string | null;
  seats: OfficeSeat[];
  reserved: ReservedDesk[];
  rooms: Room[];
  whiteboard: Whiteboard;
  inbox: {
    label: string;
    items: InboxItem[];
    ariaLabel: string;
    testId: string;
  };
  yourDesk: YourDesk;
  conveyor: Conveyor;
  parcels: Parcel[];
  paperStacks: PaperStack[];
  hush: Hush;
  door: Door;
  needs: Need[];
  usage: Usage;
  anchors: Record<AnchorId, Point>;
};

// Board (D2): same read model, plain dense layout.

export type BoardColumnId =
  'waiting' | 'active' | 'queued' | 'review' | 'merged';

export type BoardCard = {
  itemKey: string;
  title: string;
  status: WorkItemStatus;
  statusLabel: string;
  column: BoardColumnId;
  blockedBy: string[];
  ready: boolean;
  note?: string;
  pr?: { number: number; url?: string };
  attempts: number;
  reworks: number;
  vendor?: Vendor;
  badge?: VendorBadge;
  accessory: Accessory;
  seatId?: string;
  needsYou: boolean;
  error: boolean;
  tone: NameplateTone | 'muted';
  ariaLabel: string;
  testId: string;
};

export type BoardColumn = {
  id: BoardColumnId;
  label: string;
  cards: BoardCard[];
  testId: string;
};

export type LaneSegment = {
  attemptId: string;
  attempt: number;
  stageId: string;
  purpose: string;
  state: AttemptState;
  pose: Pose;
  /** Milliseconds from the workflow start; `end` is `now` while alive. */
  start: number;
  end: number;
  alive: boolean;
  ariaLabel: string;
  testId: string;
};

export type BoardLane = {
  seatId: string;
  title: string;
  badge?: VendorBadge;
  pose: Pose;
  selected: boolean;
  segments: LaneSegment[];
  ariaLabel: string;
  testId: string;
};

export type BoardViewModel = {
  workflowId: string;
  columns: BoardColumn[];
  lanes: BoardLane[];
  /** Timeline span for lane scaling, in milliseconds from the workflow start. */
  span: number;
  needs: Need[];
};
