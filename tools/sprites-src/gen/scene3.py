"""AI Office v3: the pixel office (352 x 224 px world, 16 px tiles, shown at 3x)."""
import sys
sys.path.insert(0, "/private/tmp/claude-502/-Users-clarkeyeh-workspace-personal-ai-office/c2ab3d08-754a-41fd-836a-7499b86ac36e/scratchpad/m4-pixel-src")
from pix import P, Canvas, sprite, frames_svg
from sprites import prop, monitor, char_front, char_back, ROLE, VENDOR

W, H = 352, 224
INK = P["ink"]
DOT = "'DotGothic16', 'Noto Sans TC', monospace"
SANS = "'Noto Sans TC', system-ui, sans-serif"
HAND = "'LXGW WenKai TC', 'Noto Sans TC', cursive"


def rnd(x, y, k=0):
    return ((x * 73856093) ^ (y * 19349663) ^ (k * 83492791)) & 0xFFFF


# ------------------------------------------------------------------ floors & walls
def terrazzo(c, x, y, w, h):
    c.rect(x, y, w, h, P["sand"])
    chips = [P["tan"], P["steel"], P["coral"], P["fawn"]]
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            r = rnd(xx, yy)
            if r % 23 == 0:
                c.put(xx, yy, chips[r % 4])


def carpet(c, x, y, w, h, base, dot):
    c.rect(x, y, w, h, base)
    for yy in range(y + 1, y + h, 4):
        for xx in range(x + 1 + (2 if (yy // 4) % 2 else 0), x + w, 4):
            c.put(xx, yy, dot)


def planks(c, x, y, w, h):
    c.rect(x, y, w, h, P["tan"])
    for yy in range(y, y + h):
        if (yy - y) % 5 == 4:
            c.rect(x, yy, w, 1, P["fawn"])
        else:
            off = 13 if ((yy - y) // 5) % 2 else 0
            for xx in range(x + off, x + w, 26):
                c.put(xx, yy, P["fawn"])


def checker(c, x, y, w, h):
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            c.put(xx, yy, P["sand"] if ((xx - x) // 8 + (yy - y) // 8) % 2 == 0 else P["coral"])


def hwall(c, x, y, w):
    c.rect(x, y, w, 2, P["umber"])
    c.rect(x, y + 2, w, 4, P["rust"])
    c.rect(x, y + 6, w, 2, P["brown"])


def vwall(c, x, y, h):
    c.rect(x, y, 4, h, P["umber"])
    c.rect(x + 1, y, 1, h, P["brown"])


def window(c, x, y, w=22, h=16):
    c.rect(x, y, w, h, P["umber"])
    c.rect(x + 2, y + 2, w - 4, h - 5, P["sky"])
    c.rect(x + 2, y + 2, w - 4, 3, P["cyan"])
    c.rect(x + 4, y + 6, 6, 2, P["white"])
    c.rect(x + 6, y + 5, 3, 1, P["white"])
    c.rect(x + w // 2, y + 2, 1, h - 5, P["umber"])
    c.rect(x - 1, y + h - 3, w + 2, 3, P["tan"])


def desk(c, x, y, w, d=16):
    c.rect(x, y, w, d, P["tan"])
    c.rect(x, y, w, 1, P["sand"])
    c.rect(x, y + d - 1, w, 1, P["fawn"])
    c.rect(x, y + d, w, 4, P["brick"])
    c.rect(x, y + d + 3, w, 1, P["brown"])
    c.rect(x + 1, y + d + 4, 2, 3, P["brown"])
    c.rect(x + w - 3, y + d + 4, 2, 3, P["brown"])


def stack(c, x, ybottom, sheets):
    for i in range(sheets):
        yy = ybottom - 2 * i
        c.rect(x, yy - 1, 9, 1, P["white"])
        c.rect(x + (i % 2), yy, 9, 1, P["mist"])


def blit(c, cv, x, y):
    for j, row in enumerate(cv.px):
        for i, col in enumerate(row):
            if col:
                c.put(x + i, y + j, col)


# ------------------------------------------------------------------ the world
DESKS = [8, 64, 120]


def world(stage):
    c = Canvas(W, H)
    # floors
    terrazzo(c, 0, 32, W, H - 32)
    carpet(c, 0, 32, 112, 64, P["navyblue"], P["sky"])          # meeting room
    carpet(c, 124, 40, 40, 48, P["plum"], P["rose"])            # lead's rug
    c.rect(124, 40, 40, 1, P["rose"]); c.rect(124, 87, 40, 1, P["rose"])
    planks(c, 260, 32, 92, 64)                                    # your office
    checker(c, 0, 176, 112, 48)                                   # pantry
    # back wall
    c.rect(0, 0, W, 3, P["umber"])
    c.rect(0, 3, W, 21, P["rust"])
    c.rect(0, 24, W, 1, P["tan"])
    c.rect(0, 25, W, 7, P["brown"])
    for x in range(0, W, 8):
        c.rect(x, 25, 1, 7, P["umber"])
    window(c, 6, 5); window(c, 86, 5); window(c, 122, 5); window(c, 266, 5)
    # meeting TV
    c.rect(36, 4, 42, 19, P["ink"])
    c.rect(38, 6, 38, 14, P["sky"] if stage == "meeting" else P["dusk"])
    if stage == "meeting":
        for i in range(3):
            c.rect(41, 9 + 3 * i, 18 + 6 * (i % 2), 1, P["white"])
    blit(c, prop("clock"), 152, 8)
    # whiteboard + corkboard in the hall
    c.rect(180, 3, 56, 21, P["steel"])
    c.rect(182, 5, 52, 17, P["white"])
    c.rect(186, 22, 44, 2, P["slate"])
    blit(c, prop("corkboard"), 238, 7)
    # door to main (your office)
    c.rect(310, 3, 26, 29, P["umber"])
    c.rect(312, 5, 22, 27, P["fawn"])
    c.rect(314, 7, 8, 10, P["tan"]); c.rect(324, 7, 8, 10, P["tan"])
    c.rect(314, 19, 8, 11, P["tan"]); c.rect(324, 19, 8, 11, P["tan"])
    c.rect(330, 17, 2, 3, P["amber"])
    c.rect(318, 0, 10, 3, P["ink"])
    # interior walls
    vwall(c, 112, 32, 72); vwall(c, 172, 32, 72); vwall(c, 256, 32, 72)
    hwall(c, 0, 96, 84); hwall(c, 104, 96, 12)
    hwall(c, 116, 96, 4); hwall(c, 136, 96, 40)
    hwall(c, 260, 96, 8); hwall(c, 288, 96, 64)
    hwall(c, 0, 168, 72); hwall(c, 96, 168, 20); vwall(c, 112, 168, 56)
    c.rect(0, 32, 2, H - 32, P["umber"]); c.rect(W - 2, 32, 2, H - 32, P["umber"]); c.rect(0, H - 2, W, 2, P["umber"])
    c.rect(140, 216, 32, 6, P["slate"])                          # entrance mat

    # ---- meeting room
    meet = stage == "meeting"
    for x in (26, 74):
        blit(c, prop("chair_front"), x, 44)
    if not meet:
        blit(c, prop("chair_front"), 50, 44)
    c.rect(20, 56, 72, 20, P["tan"]); c.rect(20, 56, 72, 1, P["sand"])
    c.rect(20, 75, 72, 1, P["fawn"]); c.rect(20, 76, 72, 4, P["brick"]); c.rect(20, 79, 72, 1, P["brown"])
    for x in (21, 89):
        c.rect(x, 80, 2, 3, P["brown"])
    if meet:
        for x, w in [(28, 10), (52, 9), (76, 10)]:
            c.rect(x, 62, w, 7, P["white"]); c.rect(x + 1, 64, w - 3, 1, P["mist"]); c.rect(x + 1, 66, w - 4, 1, P["mist"])
    else:
        c.rect(50, 62, 11, 8, P["white"]); c.rect(51, 64, 8, 1, P["mist"]); c.rect(51, 66, 6, 1, P["mist"])
        blit(c, prop("chair_back"), 32, 82); blit(c, prop("chair_back"), 64, 82)
        blit(c, prop("chair_front"), 96, 58)
    if meet:
        blit(c, prop("chair_back"), 32, 82)
    blit(c, prop("plant"), 94, 78 if not meet else 80)

    # ---- lead's office
    blit(c, prop("chair_front"), 137, 48)
    desk(c, 128, 60, 32, 12)
    blit(c, prop("mon_back"), 130, 52)
    blit(c, prop("mug"), 150, 63)
    blit(c, prop("plant"), 156, 34)

    # ---- hall: printer, in/out trays (交件匣), trash
    blit(c, prop("printer"), 180, 58)
    if stage == "implement":
        c.rect(184, 71, 8, 6, P["white"]); c.rect(185, 73, 6, 1, P["slate"]); c.rect(185, 75, 4, 1, P["slate"])
    c.rect(204, 78, 24, 14, P["fawn"]); c.rect(204, 78, 24, 1, P["tan"]); c.rect(204, 91, 24, 1, P["brown"])
    c.rect(215, 82, 2, 2, P["brown"])
    blit(c, prop("tray"), 206, 64)
    blit(c, prop("tray" if stage != "meeting" else "tray_empty"), 206, 71)
    blit(c, prop("trash"), 240, 82)
    blit(c, prop("plant"), 236, 34)

    # ---- your office
    blit(c, prop("chair_front"), 305, 52)
    desk(c, 290, 64, 44, 14)
    blit(c, prop("mon_back"), 318, 56)
    blit(c, prop("lamp_on" if stage == "gate" else "lamp_off"), 293, 56)
    c.rect(304, 68, 12, 7, P["fawn"]); c.rect(305, 69, 10, 5, P["tan"])
    if stage == "gate":
        c.rect(305, 66, 10, 7, P["white"]); c.rect(306, 68, 7, 1, P["mist"]); c.rect(306, 70, 5, 1, P["mist"])
        for dx, dy in [(-3, 10), (-2, 12), (2, 12), (6, 11), (10, 13), (-5, 13)]:
            c.put(296 + dx, 66 + dy, P["lemon"])
    blit(c, prop("plant"), 336, 78)
    blit(c, prop("cactus"), 272, 14)

    # ---- work area
    tools = {"implement": ["edit", "off", "off"], "meeting": ["off", "off", "off"], "gate": ["off", "off", "off"]}[stage]
    sheets = {"implement": [5, 8, 0], "meeting": [0, 0, 0], "gate": [0, 0, 0]}[stage]
    for i, dx in enumerate(DESKS):
        desk(c, dx, 116, 40, 16)
        blit(c, monitor(tools[i]), dx + 13, 107)
        c.rect(dx + 14, 120, 12, 3, P["mist"]); c.rect(dx + 15, 121, 10, 1, P["steel"])
        if sheets[i]:
            stack(c, dx + 29, 128, sheets[i])
    if stage == "implement":
        blit(c, prop("mug"), DESKS[0] + 3, 119)
        blit(c, prop("chair_back"), DESKS[1] + 18, 143)                       # feature: chair pushed out
        blit(c, prop("chair_back"), DESKS[2] + 13, 137)                       # dependent: tucked in
        c.rect(DESKS[2] + 3, 118, 10, 7, P["white"]); c.rect(DESKS[2] + 3, 118, 10, 1, P["coral"])
        c.rect(DESKS[2] + 5, 121, 6, 1, P["slate"])
    else:
        for dx in DESKS:
            blit(c, prop("chair_back"), dx + 13, 137)
    blit(c, prop("plant"), 164, 102)

    # ---- merge zone: conveyor + integrator counter
    c.rect(172, 142, 112, 1, P["mist"]); c.rect(172, 160, 112, 1, P["mist"])
    c.rect(172, 146, 108, 2, P["steel"]); c.rect(172, 156, 108, 2, P["steel"])
    c.rect(172, 148, 108, 8, P["ink"])
    for x in range(174, 280, 5):
        c.rect(x, 148, 1, 8, P["dusk"])
    for x in (178, 214, 250):
        c.rect(x, 158, 3, 3, P["slate"])
    c.rect(168, 144, 8, 16, P["slate"]); c.rect(169, 145, 6, 1, P["steel"])   # drop-in hopper
    # counter
    if stage == "implement":
        pass
    c.rect(280, 128, 68, 12, P["tan"]); c.rect(280, 128, 68, 1, P["sand"]); c.rect(280, 139, 68, 1, P["fawn"])
    c.rect(280, 140, 68, 18, P["navyblue"])
    for x in range(283, 348, 6):
        c.rect(x, 141, 2, 16, P["sky"])
    c.rect(280, 157, 68, 2, P["umber"])
    blit(c, prop("mon_back"), 330, 120)
    if stage == "implement":
        blit(c, prop("box"), 289, 124)
    else:
        c.rect(296, 130, 18, 7, P["white"]); c.rect(297, 132, 16, 1, P["red"]); c.rect(297, 134, 12, 1, P["slate"])
    # merge cart (整合分支)
    c.rect(292, 190, 52, 24, P["brown"]); c.rect(294, 192, 48, 20, P["fawn"])
    for x in range(296, 342, 8):
        c.rect(x, 192, 2, 20, P["brick"])
    c.rect(292, 190, 52, 2, P["umber"]); c.rect(296, 214, 4, 4, P["ink"]); c.rect(336, 214, 4, 4, P["ink"])
    # lounge: rug, sofa, coffee table
    c.rect(160, 192, 92, 22, P["clay"]); c.rect(162, 194, 88, 18, P["tan"])
    for x in range(164, 250, 6):
        c.rect(x, 202, 3, 1, P["clay"])
    c.rect(166, 180, 72, 2, P["rose"]); c.rect(166, 182, 72, 6, P["plum"])
    c.rect(170, 188, 64, 5, P["rose"]); c.rect(170, 193, 64, 3, P["plum"])
    c.rect(164, 184, 6, 12, P["plum"]); c.rect(234, 184, 6, 12, P["plum"]); c.rect(164, 184, 6, 1, P["rose"]); c.rect(234, 184, 6, 1, P["rose"])
    c.rect(166, 196, 2, 2, P["umber"]); c.rect(236, 196, 2, 2, P["umber"])
    c.rect(188, 202, 28, 6, P["tan"]); c.rect(188, 202, 28, 1, P["sand"]); c.rect(188, 208, 28, 3, P["brick"])
    c.rect(196, 199, 7, 4, P["white"]); c.rect(197, 200, 5, 1, P["mist"])

    # ---- pantry
    c.rect(6, 182, 58, 8, P["tan"]); c.rect(6, 182, 58, 1, P["sand"]); c.rect(6, 190, 58, 8, P["brick"]); c.rect(6, 197, 58, 1, P["brown"])
    blit(c, prop("coffee"), 12, 172)
    blit(c, prop("mug"), 30, 183); blit(c, prop("mug"), 40, 183)
    c.rect(70, 176, 18, 32, P["mist"]); c.rect(70, 176, 18, 1, P["white"]); c.rect(70, 189, 18, 1, P["steel"])
    c.rect(84, 180, 1, 6, P["slate"]); c.rect(84, 192, 1, 8, P["slate"]); c.rect(70, 207, 18, 1, P["steel"])
    c.rect(28, 206, 22, 8, P["tan"]); c.rect(28, 206, 22, 1, P["sand"]); c.rect(28, 213, 22, 2, P["fawn"])
    c.rect(36, 215, 6, 5, P["brown"])
    blit(c, prop("plant"), 92, 200)
    blit(c, prop("plant"), 118, 196)
    blit(c, prop("trash"), 262, 204)
    return c


# ------------------------------------------------------------------ overlays
def pct(v, t):
    return f"{v / t * 100:.4f}%"


def box(x, y, w, h=None):
    s = f"left:{pct(x, W)};top:{pct(y, H)};width:{pct(w, W)};"
    if h is not None:
        s += f"height:{pct(h, H)};"
    return s


def notch(n=3):
    return (f"clip-path:polygon(0 {n}px,{n}px {n}px,{n}px 0,calc(100% - {n}px) 0,calc(100% - {n}px) {n}px,100% {n}px,"
            f"100% calc(100% - {n}px),calc(100% - {n}px) calc(100% - {n}px),calc(100% - {n}px) 100%,{n}px 100%,"
            f"{n}px calc(100% - {n}px),0 calc(100% - {n}px));")


def badge(vendor, size="max(10px,1cqw)"):
    v = VENDOR[vendor]
    bg, fg = (P["sky"], P["ink"]) if vendor == "cc" else (P["leaf"], P["ink"])
    return (f'<span style="display:inline-block;padding:0 3px;background:{bg};color:{fg};font-family:{DOT};font-size:{size};'
            f'line-height:1.25;{notch(2)}">{v["short"]}</span>')


def tag(name, sub=None, vendor=None, mode="plain"):
    bg, fg, mu, fr = P["white"], P["ink"], P["slate"], P["umber"]
    if mode == "selected":
        bg, fg, mu, fr = P["ink"], P["white"], P["mist"], P["ink"]
    if mode == "need":
        bg, fg, mu, fr = P["amber"], P["ink"], P["ink"], P["umber"]
    b = badge(vendor) if vendor else ""
    s = f'<span style="display:block;font-family:{SANS};font-size:max(11px,1.05cqw);line-height:1.3;font-weight:400;color:{mu};">{sub}</span>' if sub else ""
    return (f'<span style="display:inline-block;background:{fr};padding:2px;{notch(3)}">'
            f'<span style="display:block;background:{bg};color:{fg};padding:2px 6px 3px;{notch(2)}text-align:left;white-space:nowrap;">'
            f'<span style="display:flex;align-items:center;gap:5px;font-family:{DOT};font-size:max(11px,1.15cqw);line-height:1.3;">{b}{name}</span>{s}</span></span>')


def plate(x, y, text, label, w=None):
    ww = f"width:{pct(w, W)};" if w else ""
    return (f'<button type="button" aria-label="放大{label}" style="position:absolute;left:{pct(x, W)};top:{pct(y, H)};{ww}'
            f'padding:0;border:0;background:{P["umber"]};cursor:zoom-in;{notch(2)}">'
            f'<span style="display:block;margin:2px;padding:1px 6px;background:{P["sand"]};color:{P["ink"]};font-family:{SANS};'
            f'font-weight:700;font-size:max(11px,1.05cqw);line-height:1.35;white-space:nowrap;{notch(2)}">{text}</span></button>')


def seat(x, y, w, h, label, inner, pressed=False):
    return (f'<button type="button" aria-label="{label}" aria-pressed="{"true" if pressed else "false"}" '
            f'style="position:absolute;{box(x, y, w, h)}padding:0;margin:0;border:0;background:transparent;cursor:pointer;">{inner}</button>')


def child(x, y, w, ox, oy, ow, oh, inner, cls="", extra=""):
    k = f' class="{cls}"' if cls else ""
    return (f'<span{k} style="position:absolute;left:{(x-ox)/ow*100:.3f}%;top:{(y-oy)/oh*100:.3f}%;'
            f'width:{w/ow*100:.3f}%;display:block;{extra}">{inner}</span>')


def tagpos(x, y, ox, oy, ow, oh, inner, anchor="center"):
    tr = {"center": "transform:translateX(-50%);", "left": "", "right": "transform:translateX(-100%);"}[anchor]
    return f'<span style="position:absolute;left:{(x-ox)/ow*100:.3f}%;top:{(y-oy)/oh*100:.3f}%;{tr}display:block;z-index:2;">{inner}</span>'


def bubble(x, y, w, text, who, tail_x, tail="down", strong=False):
    bw = 3 if strong else 2
    u, wh = P["umber"], P["white"]
    if tail == "down":
        t = (f'<span aria-hidden="true" style="position:absolute;left:{tail_x}%;bottom:-6px;width:9px;height:4px;background:{u};"></span>'
             f'<span aria-hidden="true" style="position:absolute;left:calc({tail_x}% + 3px);bottom:-9px;width:3px;height:4px;background:{u};"></span>')
    elif tail == "up":
        t = (f'<span aria-hidden="true" style="position:absolute;left:{tail_x}%;top:-6px;width:9px;height:4px;background:{u};"></span>'
             f'<span aria-hidden="true" style="position:absolute;left:calc({tail_x}% + 3px);top:-9px;width:3px;height:4px;background:{u};"></span>')
    else:
        t = (f'<span aria-hidden="true" style="position:absolute;top:{tail_x}%;left:-6px;width:4px;height:9px;background:{u};"></span>'
             f'<span aria-hidden="true" style="position:absolute;top:calc({tail_x}% + 3px);left:-9px;width:4px;height:3px;background:{u};"></span>')
    return (f'<div role="note" aria-label="{who} 的發言" style="position:absolute;{box(x, y, w)}z-index:3;">'
            f'<div style="background:{u};padding:{bw}px;{notch(4)}"><div style="background:{wh};padding:4px 8px 5px;font-family:{HAND};'
            f'font-size:max(12px,1.4cqw);line-height:1.35;color:{P["ink"]};{notch(3)}">{text}</div></div>{t}</div>')


def sprite_svg(cv, label=None):
    return cv.svg(label=label)


def scene(stage="implement", selected="integrator", pid="s"):
    bg = world(stage).svg()
    o = []
    # whiteboard text
    wb = {"implement": ["實作中", "進行 1　審查 1　等待 1", "token 1.04M"],
          "meeting": ["會議中", "第 2 輪 ／ 共 2 輪", "3 位說可以收斂"],
          "gate": ["等你定案", "4 位都已離座", "決定前沒人開工"]}[stage]
    lines = "".join(f'<span style="display:block;{"font-weight:700;font-size:max(12px,1.4cqw);" if i == 0 else ""}">{t}</span>' for i, t in enumerate(wb))
    o.append(f'<button type="button" aria-label="白板：切到看板" style="position:absolute;{box(183, 5, 51, 17)}padding:0 0 0 0.6cqw;border:0;background:transparent;'
             f'text-align:left;cursor:pointer;font-family:{HAND};font-size:max(10px,1.08cqw);line-height:1.25;color:{P["ink"]};display:flex;flex-direction:column;justify-content:center;">{lines}</button>')
    o.append(f'<span style="position:absolute;{box(318, 0, 10, 3)}"></span>')
    o.append(f'<span style="position:absolute;left:{pct(313, W)};top:{pct(8.5, H)};font-family:{DOT};font-size:max(10px,1.1cqw);line-height:1;color:{P["ink"]};background:{P["sand"]};padding:1px 3px;">main</span>')
    # room plates (click = zoom)
    o.append(plate(6, 86, "會議室", "會議室"))
    o.append(plate(120, 86, "主管室", "主管室"))
    o.append(plate(262, 86, "你的辦公室", "你的辦公室"))
    o.append(plate(196, 94, "交件匣", "交件匣"))
    o.append(plate(4, 104, "工位區", "工位區"))
    o.append(plate(4, 170, "茶水間", "茶水間"))
    o.append(plate(292, 177, "整合分支", "整合分支"))

    if stage == "implement":
        # persist, typing (2 frames)
        f = frames_svg([char_back("engineer", "cx", 0), char_back("engineer", "cx", 1)], css="overflow:visible;")
        ox, oy, ow, oh = DESKS[0], 104, 40, 62
        inner = child(DESKS[0] + 12, 124, 16, ox, oy, ow, oh, f)
        inner += tagpos(DESKS[0] + 20, 150, ox, oy, ow, oh, tag("persist", "實作中 12 分　148k", "cx"))
        o.append(seat(ox, oy, ow, oh, "engineer persist，Codex，實作中 12 分，用了 148k token", inner))
        # feature: left for the counter
        ox = DESKS[1]
        o.append(seat(ox, oy, ow, oh, "engineer feature 的座位：已離座，PR #5 在整合台",
                      tagpos(ox + 20, 152, ox, oy, ow, oh, tag("feature", "離座　PR #5 在整合台", "cx"))))
        ox = DESKS[2]
        o.append(seat(ox, oy, ow, oh, "dependent 的保留座位：等 feature 合併",
                      tagpos(ox + 20, 150, ox, oy, ow, oh, tag("dependent", "保留　等 feature 合併", "cx"))))
        # lead's office
        o.append(seat(122, 40, 46, 46, "lead 的座位：不在座，值班沒有提問",
                      tagpos(145, 74, 122, 40, 46, 46, tag("lead", "不在座", "cc"))))
        # integrator at the counter
        ox, oy, ow, oh = 280, 100, 68, 40
        oh2 = oh
        sel = selected == "integrator"
        inner = child(306, 106, 16, ox, oy, ow, oh, char_front("integrator", "cc", 22).svg())
        inner += tagpos(316, 160, ox, oy, ow, oh2, tag("integrator", "審查 PR #5　第 2 次", "cc", "selected" if sel else "plain"))
        o.append(seat(ox, oy, ow, oh, "integrator，Claude Code，審查 PR #5 第 2 次", inner, pressed=sel))
        o.append(f'<span style="position:absolute;{box(289.5, 125.6, 12, 6)}display:flex;align-items:center;justify-content:center;font-family:{DOT};font-size:max(9px,.85cqw);color:{P["ink"]};pointer-events:none;">#5</span>')
        o.append(plate(282, 142, "整合台", "整合台"))
        # conveyor text
        o.append(f'<span style="position:absolute;left:{pct(176, W)};top:{pct(161.5, H)};font-family:{SANS};font-size:max(11px,1.05cqw);color:{P["ink"]};">合併佇列：沒有其他 PR 在排隊</span>')
        # envelope in flight, trays -> counter
        trail = "".join(f'<span aria-hidden="true" style="position:absolute;{box(x, y, 1.6, 1.6)}background:{P["umber"]};opacity:{op};"></span>'
                        for x, y, op in [(230, 84, .3), (236, 90, .42), (241, 96, .55), (246, 101, .7)])
        o.append(trail)
        o.append(f'<div role="img" aria-label="傳給 integrator 的訊息：審查 PR #5 第 2 次" style="position:absolute;{box(250, 104, 11)}">{prop("envelope").svg()}</div>')
        o.append(f'<span style="position:absolute;left:{pct(247, W)};top:{pct(107, H)};transform:translateX(-100%);">{tag("給 integrator", "審查 PR #5 第 2 次")}</span>')
        # printer output
        o.append(f'<span style="position:absolute;left:{pct(176, W)};top:{pct(48, H)};">{tag("印表機", "剛印出 PR #5")}</span>')
        # merge cart
        o.append(f'<span style="position:absolute;left:{pct(296, W)};top:{pct(198, H)};font-family:{SANS};font-size:max(11px,1.05cqw);color:{P["white"]};font-weight:700;text-shadow:0 1px 0 {P["umber"]};">已合併 0</span>')
        # your desk
        o.append(seat(286, 44, 54, 40, "你的桌：沒有等你的事",
                      tagpos(312, 82, 286, 44, 54, 40, tag("你的桌", "沒有等你的事"))))
    elif stage == "meeting":
        def person(x, y, w, h, svg, fx, fy, fw, tg, tx, ty, label, sel=False, anchor="center"):
            inner = child(fx, fy, fw, x, y, w, h, svg) + tagpos(tx, ty, x, y, w, h, tg, anchor)
            return seat(x, y, w, h, label, inner, pressed=sel)
        o.append(person(22, 34, 24, 26, char_front("pm", "cc", 22).svg(), 25, 36, 16, tag("pm", None, "cc"), 33, 61, "pm，Claude Code，第 2 輪已發言"))
        o.append(person(70, 34, 24, 26, char_front("architect", "cc", 22).svg(), 73, 36, 16,
                        tag("architect", None, "cc", "selected" if selected == "architect" else "plain"), 81, 61, "architect，Claude Code，第 2 輪已發言", sel=selected == "architect"))
        o.append(person(58, 70, 28, 28, char_back("engineer", "cx", 0).svg(), 63, 72, 16, tag("engineer", None, "cx"), 62, 86, "engineer，Codex，第 2 輪已發言", anchor="right"))
        o.append(person(92, 40, 20, 34, char_front("lead", "cc", 32).svg(), 94, 40, 16, tag("lead", "主持", "cc"), 102, 73, "lead，Claude Code，主持會議"))
        o.append(bubble(2, 4, 62, "開關要有可及性標籤，重新整理後要保留", "pm", 46))
        o.append(bubble(68, 4, 70, "CSS 變數；偏好存 localStorage", "architect", 14, strong=True))
        o.append(bubble(120, 40, 66, "大家都說可以收斂，我來寫結論", "lead", 30, tail="left"))
        o.append(bubble(20, 104, 92, "可拆 3 項；dependent 要等 feature 合併", "engineer", 46, tail="up"))
        o.append(f'<span style="position:absolute;left:{pct(10, W)};top:{pct(152, H)};font-family:{SANS};font-size:max(11px,1.05cqw);color:{P["ink"]};">工位還沒有人：任務拆分核准後才開工</span>')
        o.append(plate(282, 142, "整合台", "整合台"))
        o.append(f'<span style="position:absolute;left:{pct(176, W)};top:{pct(161.5, H)};font-family:{SANS};font-size:max(11px,1.05cqw);color:{P["ink"]};">合併佇列：實作開始後才開放</span>')
        o.append(seat(286, 44, 54, 40, "你的桌：下一件是結論定案", tagpos(312, 82, 286, 44, 54, 40, tag("你的桌", "下一件：結論定案"))))
    else:  # gate: everyone gone, only your desk lit
        o.append(f'<span aria-hidden="true" style="position:absolute;inset:0;background:{P["ink"]};opacity:.42;'
                 f'clip-path:polygon(0 0,100% 0,100% 100%,0 100%,0 0,{pct(260, W)} {pct(32, H)},{pct(260, W)} {pct(104, H)},100% {pct(104, H)},100% {pct(32, H)},{pct(260, W)} {pct(32, H)});"></span>')
        o.append(f'<div class="px-bob" role="img" aria-label="等你：結論定案" style="position:absolute;{box(304, 40, 12)}">{prop("bang").svg()}</div>')
        o.append(seat(286, 44, 54, 40, "你的桌：結論定案在等你，已等 3 分 12 秒",
                      tagpos(312, 82, 286, 44, 54, 40, tag("結論定案", "等你 3 分 12 秒", mode="need"))))
        o.append(f'<span style="position:absolute;left:{pct(10, W)};top:{pct(152, H)};font-family:{SANS};font-size:max(11px,1.05cqw);color:{P["white"]};">所有座位都空著</span>')

    label = {"implement": "像素辦公室：實作階段", "meeting": "像素辦公室：會議中", "gate": "像素辦公室：關卡開啟，大家都離座"}[stage]
    return (f'<div role="group" aria-label="{label}" style="position:relative;width:100%;aspect-ratio:{W} / {H};container-type:inline-size;'
            f'background:{P["sand"]};overflow:hidden;">'
            f'<div style="position:absolute;inset:0;">{bg}</div>{"".join(o)}</div>')
