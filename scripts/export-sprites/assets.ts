// Builds, writes and checks apps/web/src/features/office/scene/assets/ (M4_PLAN §4.2, §4.4).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ANIMATION_FRAMES,
  buildAssets,
  colorName,
  SIGNAL_ALLOWED,
  SIGNAL_COLORS,
  type AtlasJson,
  type AtlasSprite,
  type Raster,
} from '../../apps/web/src/features/office/scene/sprites/index.ts';
import { decodePng } from './png-decode.ts';
import { encodePng } from './png.ts';

export const ASSETS_DIR = join(
  import.meta.dirname,
  '../../apps/web/src/features/office/scene/assets',
);
export const ATLAS_FILE = 'atlas.json';

export interface EncodedAssets {
  readonly atlas: AtlasJson;
  readonly images: ReadonlyMap<string, Raster>;
  /** File name -> bytes, including atlas.json. */
  readonly files: ReadonlyMap<string, Buffer>;
}

/** Pretty JSON with every innermost object or array on one line (one line per sprite). */
export function formatAtlas(atlas: AtlasJson): string {
  const oneLine = (inner: string) => inner.replace(/\n\s*/g, ' ');
  return (
    JSON.stringify(atlas, null, 2)
      .replace(/\{\n[^{}[\]]*?\n\s*\}/g, oneLine)
      .replace(/\[\n[^{}[\]]*?\n\s*\]/g, oneLine) + '\n'
  );
}

export function encodeAssets(): EncodedAssets {
  const { atlas, images } = buildAssets();
  const files = new Map<string, Buffer>([
    [ATLAS_FILE, Buffer.from(formatAtlas(atlas))],
  ]);
  for (const [file, raster] of images)
    files.set(
      file,
      encodePng(raster.width, raster.height, raster.toRgbaBytes()),
    );
  return { atlas, images, files };
}

/** RGBA with every fully transparent pixel zeroed, so optimisers' choices do not matter. */
function normalize(rgba: Uint8Array): Uint8Array {
  const out = Uint8Array.from(rgba);
  for (let i = 0; i < out.length; i += 4)
    if (out[i + 3] === 0) out.fill(0, i, i + 4);
  return out;
}

/** The sprite (and frame-local point) at a sheet pixel, for error messages. */
export function locate(
  atlas: AtlasJson,
  file: string,
  x: number,
  y: number,
): string {
  const sheet = Object.entries(atlas.sheets).find(
    ([, s]) => s.file === file,
  )?.[0];
  if (!sheet) return `${file} (${x}, ${y})`;
  for (const [name, s] of Object.entries(atlas.sprites)) {
    if (
      s.sheet !== sheet ||
      x < s.x ||
      y < s.y ||
      x >= s.x + s.w * s.frames ||
      y >= s.y + s.h
    )
      continue;
    const frame = Math.floor((x - s.x) / s.w);
    return `${name} frame ${frame} (${x - s.x - frame * s.w}, ${y - s.y}) in ${file}`;
  }
  return `${file} (${x}, ${y}), outside every sprite`;
}

/** For an atlas sheet, the sprite name owning each pixel; undefined for background strips. */
function ownerMap(
  atlas: AtlasJson,
  file: string,
  raster: Raster,
): (string | undefined)[] | undefined {
  const sheet = Object.entries(atlas.sheets).find(
    ([, s]) => s.file === file,
  )?.[0];
  if (!sheet) return undefined;
  const owner = new Array<string | undefined>(raster.width * raster.height);
  for (const [name, s] of Object.entries(atlas.sprites)) {
    if (s.sheet !== sheet) continue;
    for (let y = s.y; y < Math.min(s.y + s.h, raster.height); y++)
      for (let x = s.x; x < Math.min(s.x + s.w * s.frames, raster.width); x++)
        owner[y * raster.width + x] = name;
  }
  return owner;
}

function overlaps(a: AtlasSprite, b: AtlasSprite): boolean {
  return (
    a.sheet === b.sheet &&
    a.x < b.x + b.w * b.frames &&
    b.x < a.x + a.w * a.frames &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

/** Problems with the generated output itself: palette, signal colours, layout, determinism. */
export function checkGenerated(
  assets: EncodedAssets,
  again: EncodedAssets,
): string[] {
  const problems: string[] = [];
  const { atlas } = assets;
  for (const [file, bytes] of assets.files)
    if (!again.files.get(file)?.equals(bytes))
      problems.push(`${file}: two builds in one process gave different bytes`);
  if (assets.files.size !== again.files.size)
    problems.push('Two builds gave different file sets');

  for (const [file, raster] of assets.images) {
    const owner = ownerMap(atlas, file, raster);
    let reported = 0;
    const report = (problem: string) => {
      if (reported++ < 5) problems.push(problem);
    };
    raster.pixels.forEach((value, index) => {
      if (!value) return;
      const x = index % raster.width;
      const y = Math.floor(index / raster.width);
      const name = colorName(value);
      if (!name) {
        report(
          `${locate(atlas, file, x, y)}: #${value.toString(16).padStart(8, '0')} is not in Endesga 32`,
        );
        return;
      }
      const sprite = owner?.[index];
      if (owner && !sprite)
        report(
          `${locate(atlas, file, x, y)}: opaque pixel outside every sprite`,
        );
      for (const signal of SIGNAL_COLORS)
        if (
          name === signal &&
          !(sprite && SIGNAL_ALLOWED[signal].includes(sprite))
        )
          report(
            `${locate(atlas, file, x, y)}: ${signal} is only allowed in ${SIGNAL_ALLOWED[signal].join(', ')}`,
          );
    });
  }

  const entries = Object.entries(atlas.sprites);
  entries.forEach(([name, s], i) => {
    const sheet = atlas.sheets[s.sheet];
    if (
      s.x < 0 ||
      s.y < 0 ||
      s.x + s.w * s.frames > sheet.width ||
      s.y + s.h > sheet.height
    )
      problems.push(`${name}: frames run outside ${sheet.file}`);
    for (const [other, t] of entries.slice(i + 1))
      if (overlaps(s, t)) problems.push(`${name} overlaps ${other}`);
    const expected = ANIMATION_FRAMES[name.split('.').at(-1) ?? name];
    if (s.kind === 'animation' && expected !== s.frames)
      problems.push(
        `${name}: ${s.frames} animation frames, M4_DESIGN says ${expected ?? 'none'}`,
      );
    if (s.kind !== 'animation' && expected !== undefined)
      problems.push(`${name}: should be an animation of ${expected} frames`);
    if (s.kind === 'still' && s.frames !== 1)
      problems.push(`${name}: a still with ${s.frames} frames`);
  });
  for (const key of Object.keys(ANIMATION_FRAMES))
    if (
      !entries.some(
        ([name, s]) => s.kind === 'animation' && name.split('.').at(-1) === key,
      )
    )
      problems.push(`No animation sprite for ${key}`);
  return problems;
}

/** Differences between the committed assets directory and the generated output. */
export async function compareCommitted(
  assets: EncodedAssets,
  dir = ASSETS_DIR,
): Promise<string[]> {
  const problems: string[] = [];
  const present = new Set(
    (await readdir(dir).catch(() => [] as string[])).filter(
      (f) => !f.startsWith('.'),
    ),
  );
  for (const file of present)
    if (!assets.files.has(file))
      problems.push(`${file}: not produced by the sprite source; delete it`);
  for (const [file, bytes] of assets.files) {
    if (!present.has(file)) {
      problems.push(`${file}: missing; run pnpm sprites`);
      continue;
    }
    const committed = await readFile(join(dir, file));
    if (file === ATLAS_FILE) {
      if (!committed.equals(bytes))
        problems.push(
          `${file}: differs from the sprite source; run pnpm sprites`,
        );
      continue;
    }
    const diff = pixelDiff(committed, bytes);
    if (diff)
      problems.push(
        `${diff.kind === 'pixel' ? locate(assets.atlas, file, diff.x, diff.y) : file}: ` +
          `${diff.kind === 'pixel' ? 'pixels differ' : diff.message}; run pnpm sprites`,
      );
  }
  return problems;
}

export type PixelDiff =
  | { readonly kind: 'decode' | 'size'; readonly message: string }
  | { readonly kind: 'pixel'; readonly x: number; readonly y: number };

/** undefined when two PNGs decode to the same size and pixels; otherwise the first difference. */
export function pixelDiff(
  actual: Uint8Array,
  expected: Uint8Array,
): PixelDiff | undefined {
  let left;
  try {
    left = decodePng(actual);
  } catch (error) {
    return {
      kind: 'decode',
      message: `cannot decode (${(error as Error).message})`,
    };
  }
  const right = decodePng(expected);
  if (left.width !== right.width || left.height !== right.height)
    return {
      kind: 'size',
      message: `size ${left.width}×${left.height}, expected ${right.width}×${right.height}`,
    };
  const l = normalize(left.rgba);
  const r = normalize(right.rgba);
  for (let i = 0; i < l.length; i++)
    if (l[i] !== r[i]) {
      const px = Math.floor(i / 4);
      return {
        kind: 'pixel',
        x: px % left.width,
        y: Math.floor(px / left.width),
      };
    }
  return undefined;
}

/** Writes atlas.json when its bytes change and a PNG only when its pixels change. */
export async function writeAssets(
  assets: EncodedAssets,
  dir = ASSETS_DIR,
): Promise<string[]> {
  const written: string[] = [];
  for (const [file, bytes] of assets.files) {
    const path = join(dir, file);
    const current = await readFile(path).catch(() => undefined);
    const same =
      current &&
      (file === ATLAS_FILE
        ? current.equals(bytes)
        : pixelDiff(current, bytes) === undefined);
    if (same) continue;
    await writeFile(path, bytes);
    written.push(file);
  }
  return written;
}
