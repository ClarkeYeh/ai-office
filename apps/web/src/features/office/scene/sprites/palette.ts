// Endesga 32, the open palette by Endesga. Every opaque scene pixel uses one of these.
export const PALETTE = {
  rust: '#be4a2f',
  clay: '#d77643',
  sand: '#ead4aa',
  tan: '#e4a672',
  brick: '#b86f50',
  brown: '#733e39',
  umber: '#3e2731',
  wine: '#a22633',
  red: '#e43b44',
  orange: '#f77622',
  amber: '#feae34',
  lemon: '#fee761',
  leaf: '#63c74d',
  fern: '#3e8948',
  pine: '#265c42',
  deep: '#193c3e',
  navyblue: '#124e89',
  sky: '#0099db',
  cyan: '#2ce8f5',
  white: '#ffffff',
  mist: '#c0cbdc',
  steel: '#8b9bb4',
  slate: '#5a6988',
  dusk: '#3a4466',
  ink: '#262b44',
  night: '#181425',
  neon: '#ff0044',
  plum: '#68386c',
  rose: '#b55088',
  coral: '#f6757a',
  peach: '#e8b796',
  fawn: '#c28569',
} as const;

export type ColorName = keyof typeof PALETTE;

/** Signal colours (M4_DESIGN §2.2): amber only means "needs you", red only means an error. */
export const SIGNAL_COLORS = [
  'amber',
  'red',
] as const satisfies readonly ColorName[];
export type SignalColor = (typeof SIGNAL_COLORS)[number];

/** Opaque RGBA as an unsigned 32-bit integer (0xRRGGBBFF); 0 is transparent. */
export function rgba(name: ColorName): number {
  return ((Number.parseInt(PALETTE[name].slice(1), 16) << 8) | 0xff) >>> 0;
}

const byRgba = new Map<number, ColorName>(
  (Object.keys(PALETTE) as ColorName[]).map((name) => [rgba(name), name]),
);

/** The palette name of an RGBA value, or undefined when it is not in Endesga 32. */
export function colorName(value: number): ColorName | undefined {
  return byRgba.get(value >>> 0);
}
