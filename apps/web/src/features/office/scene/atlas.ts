import atlasText from './assets/atlas.json?raw';
import type {
  AtlasJson,
  AtlasSprite,
  SheetName,
} from './sprites/atlas-layout.ts';

// Runtime view of the exported atlas (M4-T1). The scene never imports `sprites/`
// at runtime (depcruise `scene-no-runtime-sprites`): only these types come from
// there; the data is the committed `assets/atlas.json` and its PNG sheets. The
// JSON comes in as text (`?raw`): the web tsconfig does not list `.json` files.

export const atlas = JSON.parse(atlasText) as AtlasJson;
export type { AtlasSprite, SheetName };

export const SHEET_URLS: Record<SheetName, string> = {
  characters: new URL('./assets/characters.png', import.meta.url).href,
  props: new URL('./assets/props.png', import.meta.url).href,
  fx: new URL('./assets/fx.png', import.meta.url).href,
};

export const BACKGROUND_URLS = {
  top: new URL('./assets/bg-top.png', import.meta.url).href,
  rowFirst: new URL('./assets/bg-row-first.png', import.meta.url).href,
  rowExtra: new URL('./assets/bg-row-extra.png', import.meta.url).href,
  bottom: new URL('./assets/bg-bottom.png', import.meta.url).href,
} as const;

export function spriteOf(name: string): AtlasSprite | undefined {
  return atlas.sprites[name];
}

export const placements = atlas.placements;
