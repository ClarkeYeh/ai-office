// ASCII sprite maps, as in tools/sprites-src/m4-pixel-src/pix.py.
import { Raster, type ColorMap } from './raster.ts';

function norm(rows: readonly string[], width?: number): string[] {
  const w = width ?? Math.max(...rows.map((row) => row.length));
  return rows.map((row) => row.padEnd(w, '.').slice(0, w));
}

/** Multiline ASCII map -> equal-width rows ('.' = transparent). */
export function sprite(text: string, width?: number): string[] {
  const rows = text.replace(/^\n+|\n+$/g, '').split('\n');
  return norm(
    rows.map((row) => row.trim()),
    width,
  );
}

/** A raster exactly the size of the map. */
export function rasterOf(rows: readonly string[], colors: ColorMap): Raster {
  const out = new Raster(rows[0]?.length ?? 0, rows.length);
  out.blit(rows, 0, 0, colors);
  return out;
}
