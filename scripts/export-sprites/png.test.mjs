import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodePng } from './png-decode.ts';
import { chunk, crc32, encodePng, ihdr, SIGNATURE } from './png.ts';

/** @param {Uint8Array} raw filtered scanlines @param {Buffer[]} extra chunks before IDAT */
function png(
  width = 0,
  height = 0,
  raw = new Uint8Array(),
  colorType = 6,
  depth = 8,
  extra = /** @type {Buffer[]} */ ([]),
) {
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height, colorType, depth),
    ...extra,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** A 3×3 RGBA image with distinct, non-trivial bytes. */
const W = 3;
const H = 3;
const pixels = Uint8Array.from(
  { length: W * H * 4 },
  (_, i) => (i * 37 + 11) & 0xff,
);

/** @param {number} a @param {number} b @param {number} c */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Applies one PNG filter to every row of `pixels`. @param {number} type */
function filtered(type) {
  const stride = W * 4;
  const out = new Uint8Array((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    out[y * (stride + 1)] = type;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i] ?? 0;
      const a = i >= 4 ? (pixels[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= 4 ? (pixels[(y - 1) * stride + i - 4] ?? 0) : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type] ?? 0;
      out[y * (stride + 1) + 1 + i] = (x - predictor) & 0xff;
    }
  }
  return out;
}

test('crc32 matches the PNG reference value', () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
});

test('the encoder round-trips through the decoder and is deterministic', () => {
  const bytes = encodePng(W, H, pixels);
  assert.deepEqual(decodePng(bytes), { width: W, height: H, rgba: pixels });
  assert.ok(bytes.equals(encodePng(W, H, pixels)));
  assert.ok(!bytes.includes('tIME') && !bytes.includes('tEXt'));
});

for (const type of [0, 1, 2, 3, 4])
  test(`decodes rows written with filter ${type}`, () => {
    assert.deepEqual(decodePng(png(W, H, filtered(type))).rgba, pixels);
  });

test('decodes 4-bit palette images with transparency', () => {
  // Two pixels per byte: indices 0,1 / 1,0; index 0 is transparent.
  const plte = chunk('PLTE', Uint8Array.of(1, 2, 3, 200, 100, 50));
  const trns = chunk('tRNS', Uint8Array.of(0));
  const decoded = decodePng(
    png(2, 2, Uint8Array.of(0, 0x01, 0, 0x10), 3, 4, [plte, trns]),
  );
  assert.deepEqual(
    [...decoded.rgba],
    [1, 2, 3, 0, 200, 100, 50, 255, 200, 100, 50, 255, 1, 2, 3, 0],
  );
});

test('decodes 16-bit grey with alpha and RGB with a transparent key', () => {
  const grey = decodePng(
    png(1, 1, Uint8Array.of(0, 0x80, 0x00, 0xff, 0xff), 4, 16),
  );
  assert.deepEqual([...grey.rgba], [128, 128, 128, 255]);
  const key = chunk('tRNS', Uint8Array.of(0, 9, 0, 9, 0, 9));
  const rgb = decodePng(
    png(2, 1, Uint8Array.of(0, 9, 9, 9, 1, 2, 3), 2, 8, [key]),
  );
  assert.deepEqual([...rgb.rgba], [9, 9, 9, 0, 1, 2, 3, 255]);
});

test('rejects corrupt and unsupported files', () => {
  const bytes = encodePng(W, H, pixels);
  const corrupt = Buffer.from(bytes);
  corrupt[20] = (corrupt[20] ?? 0) ^ 1;
  assert.throws(() => decodePng(corrupt), /Bad CRC/);
  assert.throws(() => decodePng(Buffer.from('nope')), /Not a PNG/);
  assert.throws(
    () => decodePng(png(1, 1, Uint8Array.of(7, 0, 0, 0, 0))),
    /Unknown PNG filter 7/,
  );
});
