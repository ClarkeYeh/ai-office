"""AI Office v3 sprite maps (16 px grid, characters 16x32). Palette: Endesga 32 (see pix.P).

Characters = one shared body template + a head per ROLE (fixed look) + a shirt per VENDOR.
Letters in character maps:
  o outline  H/h hair  S/s skin  e eye  W white  m mouth  q blush  k glasses
  A/a role accessory (beanie, visor, tie)  C/c shirt  b badge  L/l trousers  F shoes
  n/N chair (dark / light)
"""
from pix import P, sprite, Canvas

# ------------------------------------------------------------------ roles & vendors
ROLE = {
    "lead":       dict(H=P["brown"], h=P["umber"], S=P["peach"], s=P["fawn"], A=P["plum"], a=P["rose"], label="lead"),
    "pm":         dict(H=P["rust"], h=P["brown"], S=P["peach"], s=P["fawn"], A=P["lemon"], a=P["amber"], label="pm"),
    "architect":  dict(H=P["umber"], h=P["night"], S=P["brick"], s=P["brown"], A=P["ink"], a=P["ink"], label="architect"),
    "engineer":   dict(H=P["night"], h=P["night"], S=P["fawn"], s=P["brick"], A=P["coral"], a=P["rose"], label="engineer"),
    "integrator": dict(H=P["sand"], h=P["tan"], S=P["peach"], s=P["fawn"], A=P["rose"], a=P["plum"], label="integrator"),
}
VENDOR = {
    "cc": dict(C=P["sky"], c=P["navyblue"], b=P["white"], name="Claude Code", short="CC"),
    "cx": dict(C=P["leaf"], c=P["fern"], b=P["ink"], name="Codex", short="CX"),
}
BASE = dict(o=P["umber"], e=P["ink"], W=P["white"], m=P["brown"], q=P["coral"], k=P["ink"],
            L=P["dusk"], l=P["ink"], F=P["ink"], n=P["plum"], N=P["rose"])

HEAD = {
"lead": """
................
.....oooooo.....
....oHHHHHHo....
...oHHHHHhHHo...
..oHHHHHhHHHHo..
..oHHHHhHHHHHo..
..oHHSSSSSSHHo..
..oHSSSSSSSSHo..
..oSSeWSSeWSSo..
..oSSeeSSeeSSo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
""",
"pm": """
................
.....oooooo.....
....oHHHHHHoo...
...oHHHHHHHHHo..
..oHHHHHHHHHHHo.
..oHAAAAAAAAHHo.
..oHHHSSSSHHHoHo
..oHSSSSSSSSHoHo
..oSSeWSSeWSSoHo
..oSSeeSSeeSSohH
..oSSSSSSSSSSo.o
..osqSSmmSSqso..
...osSSSSSSso...
....ooSSSSoo....
""",
"architect": """
................
....oo.oo.oo....
...oHHoHHoHHo...
..oHHHHHHHHHHo..
.oHHhHHHhHHHhHo.
.oHHHHHHHHHHHHo.
..oHHSSSSSSHHo..
..oHkkkkkkkkHo..
..oSkeWkkeWkSo..
..oSkkkkkkkkSo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
""",
"engineer": """
.......aa.......
.....oooooo.....
....oAAAAAAo....
...oAAAAAAAAo...
..oAAAAAAAAAAo..
..oaaaaaaaaaao..
..oHHSSSSSSHHo..
..oHSSSSSSSSHo..
..oSSeWSSeWSSo..
..oSSeeSSeeSSo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
""",
"integrator": """
................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oAAAAAAAAAAo..
.oaaaaaaaaaaaao.
..oHSSSSSSSSHo..
..oSSSSSSSSSSo..
..oSSeWSSeWSSo..
..oSSeeSSeeSSo..
..oSSSSSSSSSSo..
..osSSSmmSSSso..
...osSSSSSSso...
....ooSSSSoo....
""",
}
BODY = """
.....oCWWCo.....
...ooCCCCCCoo...
..oCCCCCCCCCCo..
..ocCCCCCCbbco..
..ocCCCCCCbbco..
..ocCCCCCCCCco..
..ocCCCCCCCCco..
..ocCCCCCCCCco..
..oSoLLLLLLoSo..
...ooLLLLLLoo...
....oLLllLLo....
....oLLooLLo....
....oLLooLLo....
....oLLooLLo....
....oLLooLLo....
...oFFFooFFFo...
...oooo..oooo...
................
"""
TIE_ROWS = range(1, 7)          # body rows that get the lead's tie at x7-8

BACK_HEAD = {
"default": """
................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oHHHHhHHHHHo..
..oHHHHHHhHHHo..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
""",
"engineer": """
.......aa.......
.....oooooo.....
....oAAAAAAo....
...oAAAAAAAAo...
..oAAAAAAAAAAo..
..oaaaaaaaaaao..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
""",
"integrator": """
................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oAAAAAAAAAAo..
..oaHHHHHHHHao..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
""",
"pm": """
................
.....oooooo.....
....oHHHHHHo....
...oHHHHHHHHo...
..oHHHHhHHHHHo..
..oAAAAAAAAAAo..
..oHHHHHHHHHHo..
..oHHHHHHHHHHo..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhoHhhho...
....oossHsoo....
""",
"architect": """
................
....oo.oo.oo....
...oHHoHHoHHo...
..oHHHHHHHHHHo..
.oHHhHHHhHHHhHo.
.oHHHHHHHHHHHHo.
..oHHHHHHHHHHo..
..okHHHHHHHHko..
.oSHHHHHHHHHHSo.
.oSHhHHHHHHhHSo.
..ohhHHHHHHhho..
...ohhhhhhhho...
....oossssoo....
""",
}
BACK_SEAT = ["""
...ooCCCCCCoo...
..oCCCCCCCCCCo..
.oSCCCCCCCCCCSo.
..ocCCCCCCCCco..
..oNNNNNNNNNNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oooooooooooo..
.......oo.......
.....oooooo.....
""", """
...ooCCCCCCoo...
.oSCCCCCCCCCCSo.
..oCCCCCCCCCCo..
..ocCCCCCCCCco..
..oNNNNNNNNNNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oNnnnnnnnnNo..
..oooooooooooo..
.......oo.......
.....oooooo.....
"""]


def cmap(role, vendor):
    m = dict(BASE)
    m.update({k: v for k, v in ROLE[role].items() if len(k) == 1})
    m.update({k: v for k, v in VENDOR[vendor].items() if len(k) == 1})
    return m


def front_rows(role, rows=32):
    head = sprite(HEAD[role], 16)
    body = sprite(BODY, 16)
    if role == "lead":
        body = [r[:7] + "aa" + r[9:] if i in TIE_ROWS else r for i, r in enumerate(body)]
    return (head + body)[:rows]


def char_front(role, vendor, rows=32, eyes_closed=False):
    r = front_rows(role, rows)
    if eyes_closed:
        r[8] = r[8].replace("eW", "SS")
        r[9] = r[9].replace("ee", "ee")
    c = Canvas(16, rows)
    c.blit(r, 0, 0, cmap(role, vendor))
    return c


def char_back(role, vendor, frame=0, slump=0):
    head = sprite(BACK_HEAD.get(role, BACK_HEAD["default"]), 16)
    seat = sprite(BACK_SEAT[frame], 16)
    c = Canvas(16, 24)
    m = cmap(role, vendor)
    c.blit(seat, 0, 13, m)
    c.blit(head, 0, slump, m)
    return c


# ------------------------------------------------------------------ props
PROP_MAPS = {
"plant": ("""
.......G........
....G..GG..G....
...GGhGGhhGGh...
..hGGGhGGhGGGh..
..hGhGGGhGGhGh..
...hhGGhGGhGhh..
....hhhGhhhhh...
......hhhhh.....
....oooooooo....
....oTTTTTTo....
....owwwwwwo....
....owvvvvwo....
.....owwwwo.....
.....oooooo.....
""", dict(G=P["leaf"], h=P["fern"], o=P["umber"], T=P["sand"], w=P["brick"], v=P["brown"])),
"cactus": ("""
....oo....
...oGGo...
.o.oGGo.o.
oGooGhooGo
oGGGGhGGGo
.ooGGhGoo.
...oGhGo..
..oooooo..
..owwwwo..
...owwo...
...oooo...
""", dict(G=P["leaf"], h=P["fern"], o=P["pine"], w=P["clay"])),
"mon_on": ("""
.oooooooooooo.
okkkkkkkkkkkko
okSSSSSSSSSSko
okSLLLSLLSSSko
okSSSLLLLSSSko
okSLLSSLLLSSko
okSSSSSSSSSSko
.okkkkkkkkkko.
......kk......
....kkkkkk....
""", None),
"mon_off": ("""
.oooooooooooo.
okkkkkkkkkkkko
okSSSSSSSSLSko
okSSSSSSSLSSko
okSSSSSSLSSSko
okSSSSSLSSSSko
okSSSSSSSSSSko
.okkkkkkkkkko.
......kk......
....kkkkkk....
""", None),
"mon_back": ("""
.oooooooooo.
oggggggggggo
ogmmmmmmmmgo
ogmggggggmgo
ogmmmmmmmmgo
oggggggggggo
.oooooooooo.
.....oo.....
...oooooo...
""", dict(o=P["umber"], g=P["steel"], m=P["slate"])),
"chair_front": ("""
..oooooooooo..
.onnnnnnnnnno.
.onNNNNNNNNno.
.onNnnnnnnNno.
.onnnnnnnnnno.
.oooooooooooo.
oNNNNNNNNNNNNo
oNnnnnnnnnnnNo
.oooooooooooo.
......oo......
....oooooo....
""", dict(o=P["umber"], n=P["plum"], N=P["rose"])),
"chair_back": ("""
..oooooooooo..
.oNNNNNNNNNNo.
.oNnnnnnnnnNo.
.oNnnnnnnnnNo.
.oNnnnnnnnnNo.
..oooooooooo..
......oo......
....oooooo....
""", dict(o=P["umber"], n=P["plum"], N=P["rose"])),
"printer": ("""
...oooooooooo...
...oWWWWWWWWo...
.oooooooooooooo.
.oMMMMMMMMMMMMo.
.oMllllllllllMo.
.oMlGlllllllMMo.
.oMMMMMMMMMMMMo.
.oNNNNNNNNNNNNo.
.oNooooooooooNo.
.oNoWLLWLLLWoNo.
.oNoWWWWWWWWoNo.
.oNNNNNNNNNNNNo.
.oooooooooooooo.
""", dict(o=P["umber"], W=P["white"], M=P["mist"], l=P["white"], G=P["leaf"], N=P["steel"], L=P["slate"])),
"tray": ("""
oooooooooooooooooooo
oWWWWWWWWWWWWWWWWWWo
oWLLLLLLLLLWWWWWWWWo
ouuuuuuuuuuuuuuuuuuo
oFFFFFFFFFFFFFFFFFFo
oooooooooooooooooooo
""", dict(o=P["umber"], W=P["white"], L=P["mist"], u=P["tan"], F=P["fawn"])),
"tray_empty": ("""
oooooooooooooooooooo
o..................o
ouuuuuuuuuuuuuuuuuuo
oFFFFFFFFFFFFFFFFFFo
oooooooooooooooooooo
""", dict(o=P["umber"], u=P["tan"], F=P["fawn"])),
"envelope": ("""
ooooooooooo
oWWWWWWWWWo
olWWWWWWWlo
oWlWWWWWlWo
oWWllRllWWo
oWWWWWWWWWo
ooooooooooo
""", dict(o=P["umber"], W=P["white"], l=P["mist"], R=P["red"])),
"bang": ("""
.oooooooo.
oYYYYYYYYo
oYYYooYYYo
oYYYooYYYo
oYYYooYYYo
oYYYooYYYo
oYYYYYYYYo
oYYYooYYYo
oYYYooYYYo
oYYYYYYYYo
.oooYYoooo
...oYo....
....o.....
""", dict(o=P["umber"], Y=P["amber"])),
"smoke": ("""
.....llll.....
...llWWWll....
..lWWWWWWll...
.lWWllWWWWll..
.lWWWWWlWWWl..
..llWWWWWWl...
....llWWll....
......ll......
""", dict(l=P["steel"], W=P["mist"])),
"mug": ("""
ooooo..
oWWWoo.
oRRRoWo
oWWWoWo
oWWWoo.
.ooo...
""", dict(o=P["umber"], W=P["white"], R=P["coral"])),
"lamp_off": ("""
...oooo...
..oAAAAo..
.oAAAAAAo.
oAAAAAAAAo
.oooooooo.
.....oo...
....oo....
....oo....
..oooooo..
""", dict(o=P["umber"], A=P["slate"])),
"lamp_on": ("""
...oooo...
..oAAAAo..
.oAAAAAAo.
oAAAAAAAAo
.oyyyyyyo.
.yyyoyyyy.
.yy.oo.yy.
....oo....
..oooooo..
""", dict(o=P["umber"], A=P["amber"], y=P["lemon"])),
"coffee": ("""
.oooooooooo.
oNNNNNNNNNNo
oNkkkkkkkkNo
oNkGkkkkkkNo
oNNNNNNNNNNo
oNNoooooNNNo
oNNoMMMoNNNo
oNNoWWWoNNNo
oNNNNNNNNNNo
oooooooooooo
""", dict(o=P["umber"], N=P["dusk"], k=P["ink"], G=P["cyan"], M=P["brown"], W=P["white"])),
"clock": ("""
..oooooo..
.oWWWWWWo.
oWWWoWWWWo
oWWWoWWWWo
oWWWoooWWo
oWWWWWWWWo
.oWWWWWWo.
..oooooo..
""", dict(o=P["umber"], W=P["white"])),
"trash": ("""
.oooooooo.
oggggggggo
.oNNNNNNo.
.oNmNNmNo.
.oNmNNmNo.
.oNmNNmNo.
.oNNNNNNo.
..oooooo..
""", dict(o=P["umber"], g=P["mist"], N=P["steel"], m=P["slate"])),
"box": ("""
.oooooooooo.
oTTTTuTTTTTo
oTTTTuTTTTTo
ouuuuuuuuuuo
oFFFFuFFFFFo
oFFFFuFFFFFo
oFFFFuFFFFFo
.oooooooooo.
""", dict(o=P["umber"], T=P["sand"], u=P["tan"], F=P["fawn"])),
"confetti": ("""
..R.....Y....b..
.....G.....p....
b..........R..Y.
....Y..b........
.p.......G....R.
......R.....b...
..G..........p..
.......Y........
""", dict(R=P["red"], Y=P["amber"], b=P["sky"], G=P["leaf"], p=P["rose"])),
"corkboard": ("""
oooooooooooooooo
ouuuuuuuuuuuuuuo
ouWWuuuuyyyuuuuo
ouWWuuuuyyyuRRuo
ouuuuGGuuuuuRRuo
ouuuuGGuuuuuuuuo
ouuuuuuuuWWWuuuo
ouuuuuuuuWWWuuuo
ouuuuuuuuuuuuuuo
oooooooooooooooo
""", dict(o=P["brown"], u=P["clay"], W=P["white"], y=P["lemon"], R=P["coral"], G=P["leaf"])),
"jacket": ("""
..oooooooooo..
.oJJJJooJJJJo.
.oJjJJooJJjJo.
.oJjJJJJJJjJo.
..oooooooooo..
""", dict(o=P["umber"], J=P["slate"], j=P["dusk"])),
"zz": ("""
oooo....
...o....
..o..ooo
.o.....o
oooo..o.
.....o..
.....ooo
""", dict(o=P["slate"])),
}


def prop(name, recolor=None):
    text, m = PROP_MAPS[name]
    rows = sprite(text)
    c = Canvas(len(rows[0]), len(rows))
    c.blit(rows, 0, 0, recolor or m)
    return c


def monitor(state="off"):
    """state: off | edit | bash | read | error"""
    scr = {"off": (P["dusk"], P["slate"]), "edit": (P["sky"], P["white"]), "bash": (P["orange"], P["lemon"]),
           "read": (P["cyan"], P["white"]), "error": (P["red"], P["wine"])}[state]
    m = dict(o=P["umber"], k=P["ink"], S=scr[0], L=scr[1])
    return prop("mon_off" if state == "off" else "mon_on", m)
