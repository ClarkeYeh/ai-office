// sprites-sheet.html: every atlas sprite and the three mock-up boards, for review (not committed).
import {
  world,
  type Raster,
  type Stage,
} from '../../apps/web/src/features/office/scene/sprites/index.ts';
import type { EncodedAssets } from './assets.ts';
import { encodePng } from './png.ts';

function img(raster: Raster, scale: number, alt: string): string {
  const png = encodePng(
    raster.width,
    raster.height,
    raster.toRgbaBytes(),
  ).toString('base64');
  return (
    `<img alt="${alt}" src="data:image/png;base64,${png}" width="${raster.width * scale}" ` +
    `height="${raster.height * scale}">`
  );
}

export function sheetHtml(assets: EncodedAssets): string {
  const { atlas, images } = assets;
  const sprites = Object.entries(atlas.sprites)
    .map(([name, s]) => {
      const sheet = images.get(atlas.sheets[s.sheet].file);
      if (!sheet) return '';
      const frames = Array.from({ length: s.frames }, (_, i) =>
        img(sheet.crop(s.x + i * s.w, s.y, s.w, s.h), 4, `${name} ${i}`),
      ).join('');
      return `<figure>${frames}<figcaption>${name} · ${s.w}×${s.h} · ${s.kind}</figcaption></figure>`;
    })
    .join('\n');
  const strips = Object.values(atlas.background)
    .map((file) => {
      const raster = images.get(file);
      return raster
        ? `<figure>${img(raster, 2, file)}<figcaption>${file}</figcaption></figure>`
        : '';
    })
    .join('\n');
  const stages: Stage[] = ['implement', 'meeting', 'gate'];
  const boards = stages
    .map(
      (stage) =>
        `<figure>${img(world(stage), 2, stage)}<figcaption>world(${stage})</figcaption></figure>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI Office sprites</title>
<style>
body { margin: 24px; background: #f2f4f8; color: #262b44; font: 14px system-ui, sans-serif; }
section { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
figure { margin: 0; display: flex; flex-direction: column; gap: 4px; }
figure > img { image-rendering: pixelated; background: #ead4aa; }
figure img + img { margin-left: 4px; }
</style>
</head>
<body>
<h1>AI Office sprites</h1>
<h2>Mock-up boards</h2><section>${boards}</section>
<h2>Background strips</h2><section>${strips}</section>
<h2>Atlas sprites</h2><section>${sprites}</section>
</body>
</html>
`;
}
