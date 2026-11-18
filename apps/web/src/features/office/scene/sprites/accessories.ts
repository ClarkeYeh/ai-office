// Fixed role looks and accessory colour sets (M4_DESIGN §2.5).
import type { ColorName } from './palette.ts';

export const ROLES = [
  'lead',
  'pm',
  'architect',
  'engineer',
  'integrator',
] as const;
export type Role = (typeof ROLES)[number];

export interface RoleLook {
  /** Hair and hair shadow. */
  readonly H: ColorName;
  readonly h: ColorName;
  /** Skin and skin shadow. */
  readonly S: ColorName;
  readonly s: ColorName;
}

export const ROLE_LOOK: Readonly<Record<Role, RoleLook>> = {
  lead: { H: 'brown', h: 'umber', S: 'peach', s: 'fawn' },
  pm: { H: 'rust', h: 'brown', S: 'peach', s: 'fawn' },
  architect: { H: 'umber', h: 'night', S: 'brick', s: 'brown' },
  engineer: { H: 'night', h: 'night', S: 'fawn', s: 'brick' },
  integrator: { H: 'sand', h: 'tan', S: 'peach', s: 'fawn' },
};

/** An accessory colour pair: A is the main colour, a the shade. */
export interface Accessory {
  readonly A: ColorName;
  readonly a: ColorName;
}

/**
 * Each role's own accessory (tie, hair band, glasses, beanie, visor). The pm hair band
 * was lemon/amber in the mock-ups; it is cyan/sky so that amber stays "needs you".
 */
export const DEFAULT_ACCESSORY: Readonly<Record<Role, Accessory>> = {
  lead: { A: 'plum', a: 'rose' },
  pm: { A: 'cyan', a: 'sky' },
  architect: { A: 'ink', a: 'ink' },
  engineer: { A: 'coral', a: 'rose' },
  integrator: { A: 'rose', a: 'plum' },
};

/** Colour sets for further instances of the same role, chosen by itemKey (never amber or red). */
export const ACCESSORY_SETS = {
  cyan: { A: 'cyan', a: 'sky' },
  leaf: { A: 'leaf', a: 'fern' },
  tan: { A: 'tan', a: 'brick' },
  plum: { A: 'plum', a: 'rose' },
  steel: { A: 'steel', a: 'slate' },
} as const satisfies Readonly<Record<string, Accessory>>;

export const ACCESSORIES = [
  'default',
  'cyan',
  'leaf',
  'tan',
  'plum',
  'steel',
] as const satisfies readonly ('default' | keyof typeof ACCESSORY_SETS)[];
export type AccessoryName = (typeof ACCESSORIES)[number];

export function accessoryOf(role: Role, name: AccessoryName): Accessory {
  return name === 'default' ? DEFAULT_ACCESSORY[role] : ACCESSORY_SETS[name];
}
