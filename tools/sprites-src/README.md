# Sprite sources (design reference)

These are the original sprite and mock-up sources for the M4 pixel office,
committed as-is so that the TypeScript port can be checked against them.

| Path                      | Contents                                                             |
| ------------------------- | -------------------------------------------------------------------- |
| `m4-pixel-src/pix.py`     | Endesga 32 palette, ASCII sprite maps, a pixel canvas and SVG output |
| `m4-pixel-src/sprites.py` | Character heads/bodies per role and vendor, props and effect sprites |
| `gen/scene3.py`           | The 352×224 office floor (`world()`) and the scene overlays          |
| `gen/pages3.py`           | The v3 mock-up pages, including the sprite sheet page                |
| `canvas-v3/`              | The generated v3 boards (`*.dc.html`)                                |
| `shots/`                  | Screenshots of the v3 boards; the visual target for M4               |

All art is drawn for this project; the palette is Endesga 32 by Endesga.

The production source of truth is the TypeScript port in
`apps/web/src/features/office/scene/sprites/`; `pnpm sprites` exports it to
`apps/web/src/features/office/scene/assets/` and `pnpm sprites:check` verifies
the committed output. The scripts here still carry absolute paths from the
machine they were drawn on; to run them, put `m4-pixel-src/` on `sys.path`.

This directory stays until the M4 final; M4-T16 recommends whether to delete it.
