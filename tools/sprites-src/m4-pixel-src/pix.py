"""Tiny pixel engine: palette, ASCII sprite maps, a canvas, and crisp SVG output.

Every colour becomes ONE <path> made of run-length rectangles (M x y h n v1 h-n z),
drawn with shape-rendering="crispEdges". Coordinates are in sprite pixels; the SVG
viewBox keeps them, so any integer CSS scale stays crisp.
"""

# Endesga 32 (open palette by Endesga). Key -> hex.
E32 = {
    "be4a2f": "rust", "d77643": "clay", "ead4aa": "sand", "e4a672": "tan", "b86f50": "brick",
    "733e39": "brown", "3e2731": "umber", "a22633": "wine", "e43b44": "red", "f77622": "orange",
    "feae34": "amber", "fee761": "lemon", "63c74d": "leaf", "3e8948": "fern", "265c42": "pine",
    "193c3e": "deep", "124e89": "navyblue", "0099db": "sky", "2ce8f5": "cyan", "ffffff": "white",
    "c0cbdc": "mist", "8b9bb4": "steel", "5a6988": "slate", "3a4466": "dusk", "262b44": "ink",
    "181425": "night", "ff0044": "neon", "68386c": "plum", "b55088": "rose", "f6757a": "coral",
    "e8b796": "peach", "c28569": "fawn",
}
P = {name: "#" + hx for hx, name in E32.items()}


def norm(rows, w=None):
    rows = [r.rstrip("\n") for r in rows]
    w = w or max(len(r) for r in rows)
    return [r.ljust(w, ".")[:w] for r in rows]


def sprite(text, w=None):
    """Multiline ASCII map -> list of equal-width rows ('.' = transparent)."""
    rows = [r for r in text.strip("\n").split("\n")]
    return norm([r.strip() for r in rows], w)


class Canvas:
    def __init__(self, w, h, bg=None):
        self.w, self.h = w, h
        self.px = [[bg] * w for _ in range(h)]

    def put(self, x, y, col):
        if col and 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = col

    def rect(self, x, y, w, h, col):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.put(xx, yy, col)

    def blit(self, rows, x, y, cmap, flip=False):
        for j, r in enumerate(rows):
            if flip:
                r = r[::-1]
            for i, ch in enumerate(r):
                if ch != ".":
                    self.put(x + i, y + j, cmap[ch])

    def svg(self, css="", label=None, cls=""):
        by = {}
        for y, row in enumerate(self.px):
            x = 0
            while x < self.w:
                c = row[x]
                if c is None:
                    x += 1
                    continue
                n = 1
                while x + n < self.w and row[x + n] == c:
                    n += 1
                by.setdefault(c, []).append(f"M{x} {y}h{n}v1h-{n}z")
                x += n
        paths = "".join(f'<path fill="{c}" d="{"".join(d)}"></path>' for c, d in by.items())
        aria = f' role="img" aria-label="{label}"' if label else ' aria-hidden="true"'
        k = f' class="{cls}"' if cls else ""
        return (f'<svg{aria}{k} viewBox="0 0 {self.w} {self.h}" shape-rendering="crispEdges" '
                f'style="display:block;width:100%;height:auto;{css}">{paths}</svg>')

    def group(self, cls):
        """Paths only, wrapped in a <g> (for multi-frame sprites)."""
        s = self.svg()
        inner = s[s.index(">") + 1: s.rindex("</svg>")]
        return f'<g class="{cls}">{inner}</g>'


def frames_svg(canvases, label=None, css=""):
    """Several same-size canvases as frames f1, f2 ... in one svg (CSS steps() animation toggles them)."""
    w, h = canvases[0].w, canvases[0].h
    gs = "".join(c.group(f"f{i+1}") for i, c in enumerate(canvases))
    aria = f' role="img" aria-label="{label}"' if label else ' aria-hidden="true"'
    return (f'<svg{aria} viewBox="0 0 {w} {h}" shape-rendering="crispEdges" '
            f'style="display:block;width:100%;height:auto;{css}">{gs}</svg>')


def to_png_grid(canvas):
    """Hook for production export (rows of hex or None) -> feed to any PNG writer."""
    return canvas.px
