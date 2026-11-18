/** Symbolic locations only; the scene resolves them using its current layout. */
export type Anchor =
  | { kind: 'seat'; seatId: string }
  | { kind: 'workitem'; itemKey: string }
  | { kind: 'meeting'; seatId: string }
  | {
      kind:
        | 'entrance'
        | 'inbox'
        | 'your-desk'
        | 'printer'
        | 'counter'
        | 'conveyor'
        | 'integration-cart'
        | 'main-door';
    };

export type Effect =
  | {
      kind: 'walk-in' | 'walk-out' | 'walk-to-meeting';
      attemptId: string;
      from: Anchor;
      to: Anchor;
    }
  /** Route includes the inbox, without duplicate zero-length legs. */
  | {
      kind: 'envelope';
      route: readonly [Anchor, Anchor, ...Anchor[]];
      reducedMotion: { kind: 'flash-nameplate'; at: Anchor };
    }
  | { kind: 'print'; artifactId: string; at: Anchor }
  | {
      kind: 'conveyor' | 'parcel-to-counter' | 'parcel-return';
      itemKey: string;
      from: Anchor;
      to: Anchor;
    }
  | { kind: 'merge'; itemKey: string; from: Anchor; to: Anchor; confetti: true }
  | { kind: 'paper-grow'; at: Anchor; fromSheets: number; toSheets: number }
  | { kind: 'door-open'; at: Anchor; confetti: true }
  | { kind: 'flash-nameplate'; at: Anchor };
