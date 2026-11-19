import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  Raster,
  rgba,
} from '../../apps/web/src/features/office/scene/sprites/index.ts';
import {
  ASSETS_DIR,
  checkGenerated,
  compareCommitted,
  encodeAssets,
  writeAssets,
} from './assets.ts';
import { decodePng } from './png-decode.ts';
import { chunk, encodePng, ihdr, SIGNATURE } from './png.ts';

const assets = encodeAssets();

/** Runs with a scratch copy of the committed assets. @param {(dir: string) => Promise<void>} run */
async function withCopy(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-office-sprites-'));
  try {
    await cp(ASSETS_DIR, dir, { recursive: true });
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The same pixels with Paeth filters and default compression: different bytes. @param {Buffer} bytes */
function recompress(bytes) {
  const { width, height, rgba: pixels } = decodePng(bytes);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 2; // Up
    for (let i = 0; i < stride; i++) {
      const above = y > 0 ? (pixels[(y - 1) * stride + i] ?? 0) : 0;
      raw[y * (stride + 1) + 1 + i] =
        ((pixels[y * stride + i] ?? 0) - above) & 0xff;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

test('the committed assets match the sprite source', async () => {
  assert.deepEqual(checkGenerated(assets, encodeAssets()), []);
  assert.deepEqual(await compareCommitted(assets), []);
});

test('one changed pixel fails the check and names the sprite', () =>
  withCopy(async (dir) => {
    const sprite = assets.atlas.sprites['char.engineer.codex.default.type'];
    assert.ok(sprite);
    const file = join(dir, 'characters.png');
    const { width, height, rgba: pixels } = decodePng(await readFile(file));
    const at = ((sprite.y + 5) * width + sprite.x + sprite.w + 3) * 4;
    pixels[at] = (pixels[at] ?? 0) ^ 0xff;
    pixels[at + 3] = 255;
    await writeFile(file, encodePng(width, height, pixels));
    assert.deepEqual(await compareCommitted(assets, dir), [
      'char.engineer.codex.default.type frame 1 (3, 5) in characters.png: pixels differ; run pnpm sprites',
    ]);
  }));

test('a re-compressed PNG with the same pixels passes and is not rewritten', () =>
  withCopy(async (dir) => {
    const file = join(dir, 'props.png');
    const smaller = recompress(await readFile(file));
    await writeFile(file, smaller);
    assert.deepEqual(await compareCommitted(assets, dir), []);
    const before = (await stat(file)).mtimeMs;
    assert.deepEqual(await writeAssets(assets, dir), []);
    assert.ok((await readFile(file)).equals(smaller));
    assert.equal((await stat(file)).mtimeMs, before);
  }));

test('missing, stale and unexpected files are reported', () =>
  withCopy(async (dir) => {
    await rm(join(dir, 'fx.png'));
    await writeFile(join(dir, 'atlas.json'), '{}\n');
    await writeFile(join(dir, 'old.png'), encodePng(1, 1, new Uint8Array(4)));
    assert.deepEqual(await compareCommitted(assets, dir), [
      'old.png: not produced by the sprite source; delete it',
      'atlas.json: differs from the sprite source; run pnpm sprites',
      'fx.png: missing; run pnpm sprites',
    ]);
    assert.deepEqual((await writeAssets(assets, dir)).sort(), [
      'atlas.json',
      'fx.png',
    ]);
  }));

test('palette, signal colours and layout are enforced', () => {
  const sheet = assets.images.get('props.png');
  /** @type {{ sprites: Record<string, import('../../apps/web/src/features/office/scene/sprites/index.ts').AtlasSprite> }} */
  const atlas = JSON.parse(JSON.stringify(assets.atlas));
  assert.ok(sheet);
  const broken = new Raster(sheet.width, sheet.height);
  broken.draw(sheet, 0, 0);
  const mug = atlas.sprites.mug;
  assert.ok(mug);
  broken.pixels[mug.y * broken.width + mug.x] = rgba('amber');
  broken.pixels[mug.y * broken.width + mug.x + 1] = 0x123456ff;
  atlas.sprites.extra = { ...mug };
  const bang = atlas.sprites.bang;
  assert.ok(bang);
  atlas.sprites.bang = { ...bang, frames: 3 };
  const images = new Map(assets.images);
  images.set('props.png', broken);
  const problems = checkGenerated(
    { ...assets, atlas: { ...assets.atlas, sprites: atlas.sprites }, images },
    assets,
  );
  for (const expected of [
    /mug frame 0 \(0, 0\) in props\.png: amber is only allowed in lamp\.on, bang/,
    /mug frame 0 \(1, 0\) in props\.png: #123456ff is not in Endesga 32/,
    /mug overlaps extra/,
    /bang: 3 animation frames, M4_DESIGN says 2/,
  ])
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${expected} in ${problems.join('\n')}`,
    );
});
