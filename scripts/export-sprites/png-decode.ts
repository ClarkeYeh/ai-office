// PNG decoder for comparing pixels: every colour type, bit depths 1–16, tRNS, and all five
// row filters, so a PNG re-compressed by an optimiser still decodes to the same RGBA.
import { inflateSync } from 'node:zlib';
import { crc32, SIGNATURE } from './png.ts';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** 8-bit RGBA, row order. */
  readonly rgba: Uint8Array;
}

const CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses the row filters; returns the rows without their filter bytes. */
export function unfilter(
  data: Uint8Array,
  height: number,
  stride: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)];
    const row = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const at = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (out[at + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[at - stride + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (out[at - stride + i - bpp] ?? 0) : 0;
      const x = row[i] ?? 0;
      let value: number;
      switch (type) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`Unknown PNG filter ${String(type)} on row ${y}`);
      }
      out[at + i] = value & 0xff;
    }
  }
  return out;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  for (;;) {
    if (offset + 12 > buf.length) throw new Error('Truncated PNG');
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(buf.subarray(offset + 4, offset + 8 + length)) !==
      buf.readUInt32BE(offset + 8 + length)
    )
      throw new Error(`Bad CRC in ${type}`);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unknown colour type ${colorType}`);
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const rows = unfilter(
    inflateSync(Buffer.concat(idat)),
    height,
    stride,
    Math.max(1, bitsPerPixel >> 3),
  );
  const max = (1 << depth) - 1;
  const sample = (y: number, index: number): number => {
    if (depth === 16)
      return (
        (rows[y * stride + index * 2] ?? 0) * 256 +
        (rows[y * stride + index * 2 + 1] ?? 0)
      );
    if (depth === 8) return rows[y * stride + index] ?? 0;
    const bit = index * depth;
    return (
      ((rows[y * stride + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & max
    );
  };
  // Scale a sample to 8 bits; palette indices are not scaled.
  const to8 = (value: number): number =>
    depth === 16 ? value >> 8 : Math.round((value * 255) / max);
  const trnsValue = (i: number): number | undefined =>
    trns && trns.length >= (i + 1) * 2 ? trns.readUInt16BE(i * 2) : undefined;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const s = (k: number) => sample(y, x * channels + k);
      let px: [number, number, number, number];
      if (colorType === 3) {
        const i = s(0);
        if (!palette || i * 3 + 2 >= palette.length)
          throw new Error('Palette index out of range');
        px = [
          palette[i * 3] ?? 0,
          palette[i * 3 + 1] ?? 0,
          palette[i * 3 + 2] ?? 0,
          trns?.[i] ?? 255,
        ];
      } else if (colorType === 0) {
        const g = s(0);
        px = [to8(g), to8(g), to8(g), trnsValue(0) === g ? 0 : 255];
      } else if (colorType === 4)
        px = [to8(s(0)), to8(s(0)), to8(s(0)), to8(s(1))];
      else if (colorType === 2) {
        const [r, g, b] = [s(0), s(1), s(2)];
        const key =
          trnsValue(0) === r && trnsValue(1) === g && trnsValue(2) === b;
        px = [to8(r), to8(g), to8(b), key ? 0 : 255];
      } else px = [to8(s(0)), to8(s(1)), to8(s(2)), to8(s(3))];
      rgba.set(px, (y * width + x) * 4);
    }
  return { width, height, rgba };
}
