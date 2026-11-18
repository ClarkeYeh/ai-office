import { describe, expect, it } from 'vitest';
import { charBack, charFront, charWalk } from './characters.ts';
import { packSprites, SPRITES } from './atlas-layout.ts';
import { buildAssets, renderSprite } from './index.ts';
import { rasterOf, sprite } from './maps.ts';
import { colorName, rgba } from './palette.ts';
import { Raster } from './raster.ts';

describe('sprite maps and rasters', () => {
  it('pads, trims and clips like the Python canvas', () => {
    expect(sprite('\n  ab\nc  \n', 3)).toEqual(['ab.', 'c..']);
    const r = rasterOf(['a.', '.a'], { a: 'ink' });
    r.put(5, 5, 'red');
    expect([...r.pixels]).toEqual([rgba('ink'), 0, 0, rgba('ink')]);
    expect(r.crop(1, 1, 2, 2).get(0, 0)).toBe(rgba('ink'));
    expect(colorName(rgba('amber'))).toBe('amber');
    expect(colorName(0x12345678)).toBeUndefined();
    expect(() => new Raster(1, 1).blit(['z'], 0, 0, {})).toThrow(
      /No colour for 'z'/,
    );
  });

  it('draws characters at the sizes in M4_DESIGN §2.1', () => {
    const look = {
      role: 'engineer',
      vendor: 'codex',
      accessory: 'leaf',
    } as const;
    expect([
      charFront(look).height,
      charFront(look, 22).height,
      charBack(look).height,
    ]).toEqual([32, 22, 24]);
    const walk = charWalk(look);
    expect(walk).toHaveLength(4);
    expect(walk[0]?.pixels).toEqual(walk[2]?.pixels);
    expect(walk[1]?.pixels).not.toEqual(walk[3]?.pixels);
    // The accessory colour set reaches the beanie, the closed-eye idle pose differs from upper.
    expect(charFront(look).get(7, 0)).toBe(rgba('fern'));
    expect(charFront(look, 22, true).pixels).not.toEqual(
      charFront(look, 22).pixels,
    );
  });

  it('packs every sprite once, frames side by side in one row', () => {
    const { sprites, heights } = packSprites();
    expect(Object.keys(sprites)).toHaveLength(SPRITES.length);
    for (const spec of SPRITES) {
      const at = sprites[spec.name];
      expect(at && at.x + spec.w * spec.frames).toBeLessThanOrEqual(
        { characters: 160, props: 128, fx: 544 }[spec.sheet],
      );
      expect(at && at.y + spec.h).toBeLessThanOrEqual(heights[spec.sheet]);
      expect(renderSprite(spec.name)).toHaveLength(spec.frames);
    }
    expect(() => renderSprite('nope')).toThrow(/No art/);
  });

  it('builds the background strips and sheets', () => {
    const { images, atlas } = buildAssets();
    const strip = (file: string) => images.get(file);
    expect(strip(atlas.background.top)?.height).toBe(104);
    expect(strip(atlas.background.rowExtra)?.height).toBe(64);
    expect(strip(atlas.sheets.characters.file)?.height).toBe(
      atlas.sheets.characters.height,
    );
  });
});
