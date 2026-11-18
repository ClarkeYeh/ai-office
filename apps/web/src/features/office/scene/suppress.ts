import type { Anchor, OfficeViewModel } from '../model/index.js';
import { seatOfAnchor } from './geometry.js';
import type { QueuedEffect } from './player.js';

// While an effect plays, the static floor (which already shows the result) hides
// what the effect animates: the walking figure, the moving parcel, the growing
// stack, the opening door. Nameplates named by a flash get a one-off outline.

export type Suppressed = {
  /** Seat ids whose figure is walking in. */
  seats: ReadonlySet<string>;
  /** Item keys whose parcel is moving. */
  parcels: ReadonlySet<string>;
  /** Desk indexes whose paper stack is growing. */
  stacks: ReadonlySet<number>;
  door: boolean;
  /** Nameplate keys (`plateKey`) to flash. */
  flash: ReadonlySet<string>;
};

export const NOTHING_SUPPRESSED: Suppressed = {
  seats: new Set(),
  parcels: new Set(),
  stacks: new Set(),
  door: false,
  flash: new Set(),
};

export const seatPlateKey = (seatId: string) => `seat:${seatId}`;
export const reservedPlateKey = (itemKey: string) => `reserved:${itemKey}`;

/** The nameplate standing for an anchor, if it has one. */
export function plateKey(
  vm: Pick<OfficeViewModel, 'seats' | 'reserved'>,
  anchor: Anchor,
): string | undefined {
  switch (anchor.kind) {
    case 'your-desk':
    case 'inbox':
      return anchor.kind;
    case 'counter': {
      const seat = vm.seats.find((s) => s.place === 'counter');
      return seat && seatPlateKey(seat.seatId);
    }
    case 'seat':
    case 'meeting':
    case 'workitem': {
      const seat = seatOfAnchor(vm, anchor);
      if (seat) return seatPlateKey(seat.seatId);
      if (anchor.kind !== 'workitem') return undefined;
      return vm.reserved.some((r) => r.itemKey === anchor.itemKey)
        ? reservedPlateKey(anchor.itemKey)
        : undefined;
    }
    default:
      return undefined;
  }
}

export function suppressed(
  vm: Pick<OfficeViewModel, 'seats' | 'reserved'>,
  playing: readonly QueuedEffect[],
): Suppressed {
  if (playing.length === 0) return NOTHING_SUPPRESSED;
  const seats = new Set<string>();
  const parcels = new Set<string>();
  const stacks = new Set<number>();
  const flash = new Set<string>();
  let door = false;
  for (const { effect } of playing) {
    switch (effect.kind) {
      case 'walk-in':
      case 'walk-to-meeting': {
        const seat = seatOfAnchor(vm, effect.to);
        if (seat) seats.add(seat.seatId);
        break;
      }
      case 'conveyor':
      case 'parcel-to-counter':
      case 'parcel-return':
      case 'merge':
        parcels.add(effect.itemKey);
        break;
      case 'paper-grow': {
        const desk = seatOfAnchor(vm, effect.at)?.desk;
        if (desk !== undefined) stacks.add(desk);
        break;
      }
      case 'door-open':
        door = true;
        break;
      case 'flash-nameplate': {
        const key = plateKey(vm, effect.at);
        if (key) flash.add(key);
        break;
      }
      default:
        break;
    }
  }
  return { seats, parcels, stacks, door, flash };
}
