// Vendor looks (M4_DESIGN §2.4): only the shirt and the chest badge change.
import type { ColorName } from './palette.ts';

export const VENDORS = ['claude-code', 'codex'] as const;
export type Vendor = (typeof VENDORS)[number];

export interface VendorLook {
  /** Shirt. */
  readonly C: ColorName;
  /** Shirt shadow. */
  readonly c: ColorName;
  /** Chest badge. */
  readonly b: ColorName;
}

export const VENDOR_LOOK: Readonly<Record<Vendor, VendorLook>> = {
  'claude-code': { C: 'sky', c: 'navyblue', b: 'white' },
  codex: { C: 'leaf', c: 'fern', b: 'ink' },
};
