import { rgba, type ColorName } from './palette.ts';

/** Character -> colour for ASCII maps; '.' is always transparent. */
export type ColorMap = Readonly<Record<string, ColorName>>;

/** A pure RGBA pixel grid (one 0xRRGGBBAA integer per pixel, 0 = transparent). */
export class Raster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint32Array(width * height);
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x] ?? 0;
  }

  /** Sets one pixel; out-of-bounds writes are clipped, like the Python canvas. */
  put(x: number, y: number, color: ColorName | null): void {
    if (color && x >= 0 && y >= 0 && x < this.width && y < this.height)
      this.pixels[y * this.width + x] = rgba(color);
  }

  rect(x: number, y: number, w: number, h: number, color: ColorName): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) this.put(xx, yy, color);
  }

  /** Draws an ASCII map; every non-'.' character must be in the colour map. */
  blit(rows: readonly string[], x: number, y: number, colors: ColorMap): void {
    rows.forEach((row, j) => {
      [...row].forEach((ch, i) => {
        if (ch === '.') return;
        const color = colors[ch];
        if (!color) throw new Error(`No colour for '${ch}' in sprite map`);
        this.put(x + i, y + j, color);
      });
    });
  }

  /** Copies the opaque pixels of another raster onto this one. */
  draw(source: Raster, x: number, y: number): void {
    for (let j = 0; j < source.height; j++)
      for (let i = 0; i < source.width; i++) {
        const value = source.get(i, j);
        if (
          value &&
          x + i >= 0 &&
          y + j >= 0 &&
          x + i < this.width &&
          y + j < this.height
        )
          this.pixels[(y + j) * this.width + x + i] = value;
      }
  }

  /** A copy of the rectangle (x, y, w, h). */
  crop(x: number, y: number, w: number, h: number): Raster {
    const out = new Raster(w, h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        out.pixels[j * w + i] = this.get(x + i, y + j);
    return out;
  }

  /** RGBA bytes in row order, as a PNG encoder wants them. */
  toRgbaBytes(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 4);
    this.pixels.forEach((value, index) => {
      out[index * 4] = value >>> 24;
      out[index * 4 + 1] = (value >>> 16) & 0xff;
      out[index * 4 + 2] = (value >>> 8) & 0xff;
      out[index * 4 + 3] = value & 0xff;
    });
    return out;
  }
}
