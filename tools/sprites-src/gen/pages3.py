import os
from scene3 import *
from sprites import ROLE, VENDOR, PROP_MAPS, prop, monitor, char_front, char_back
from pix import Canvas, E32

BASE = "/private/tmp/claude-502/-Users-clarkeyeh-workspace-personal-ai-office/c2ab3d08-754a-41fd-836a-7499b86ac36e/scratchpad"
OUT = BASE + "/m4-design-v3/project"
PREV = BASE + "/m4gen3/prev"

BG, PAPER, FR, MU = "#F2F4F8", P["white"], P["ink"], P["slate"]
FONTS = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DotGothic16'
         '&amp;family=LXGW+WenKai+TC:wght@400;700&amp;family=Noto+Sans+TC:wght@400;500;700&amp;display=swap">')
STYLE = """body{margin:0;background:#F2F4F8;color:#262b44;font-family:"Noto Sans TC",system-ui,sans-serif;font-size:15px;line-height:1.55}
a{color:inherit}
button:focus-visible,a:focus-visible,textarea:focus-visible{outline:3px solid #feae34;outline-offset:2px}
@keyframes px-a{0%{visibility:visible}50%{visibility:hidden}}
@keyframes px-b{0%{visibility:hidden}50%{visibility:visible}}
.f1{animation:px-a .6s steps(1,end) infinite}
.f2{visibility:hidden;animation:px-b .6s steps(1,end) infinite}
@keyframes px-bob{0%{transform:translateY(0)}50%{transform:translateY(-14%)}}
.px-bob{animation:px-bob .9s steps(1,end) infinite}
@media (prefers-reduced-motion:reduce){.f1,.f2,.px-bob{animation:none}.f2{visibility:hidden}}"""


def panel(inner, bg=PAPER, frame=FR, pad="14px 16px", extra="", label=None):
    al = f' aria-label="{label}"' if label else ""
    return (f'<section{al} style="background:{frame};padding:3px;{notch(5)}{extra}">'
            f'<div style="background:{bg};padding:{pad};{notch(3)}display:flex;flex-direction:column;gap:12px;">{inner}</div></section>')


def btn(text, kind="primary", full=False, icon=""):
    w = "width:100%;" if full else ""
    if kind == "primary":
        outer, inner, fg = FR, FR, PAPER
    elif kind == "danger":
        outer, inner, fg = P["red"], PAPER, P["wine"]
    else:
        outer, inner, fg = FR, PAPER, FR
    return (f'<button type="button" style="padding:3px;border:0;background:{outer};cursor:pointer;{notch(4)}{w}">'
            f'<span style="display:flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:0 16px;background:{inner};color:{fg};'
            f'font-family:{SANS};font-size:15px;font-weight:700;{notch(2)}">{icon}{text}</span></button>')


def pxicon(rows, cmap, size=16):
    r = sprite(rows)
    c = Canvas(len(r[0]), len(r))
    c.blit(r, 0, 0, cmap)
    return f'<span aria-hidden="true" style="display:inline-block;width:{size}px;flex:none;line-height:0;">{c.svg()}</span>'


CHECK = pxicon("""
.......o
......oo
o....oo.
oo..oo..
.oooo...
..oo....
""", dict(o=FR), 12)
FLAG = pxicon("""
oooooo
oYYYYo
oYYYo.
oYYYYo
oooooo
o.....
o.....
""", dict(o=FR, Y=P["amber"]), 11)
BANG = pxicon(PROP_MAPS["bang"][0], PROP_MAPS["bang"][1], 14)
LOGO = pxicon("""
oooooooooo
oSSSSSSSSo
oSoooooSSo
oSoTTToSSo
oSoTTToSSo
oSoTTAoSSo
oSoTTToSSo
oSoTTToSSo
oooooooooo
""", dict(o=FR, S=P["rust"], T=P["tan"], A=P["amber"]), 22)

STAGES = [("會議", "s"), ("結論定案", "g"), ("拆分", "s"), ("任務拆分", "g"), ("實作", "s"), ("收尾", "s"), ("最終 PR", "g")]


def stepper(states):
    out = []
    for (name, kind), st in zip(STAGES, states):
        if st == "active":
            fr, bg, fg, pre = FR, FR, PAPER, ""
        elif st == "open":
            fr, bg, fg, pre = FR, P["amber"], FR, FLAG
        elif st == "done":
            fr, bg, fg, pre = P["mist"], PAPER, FR, CHECK
        else:
            fr, bg, fg, pre = P["mist"], BG, MU, (FLAG if kind == "g" else "")
        if kind == "g" and st == "done":
            pre = CHECK
        cur = ' aria-current="step"' if st in ("active", "open") else ""
        out.append(f'<li{cur} style="background:{fr};padding:2px;{notch(3)}"><span style="display:flex;align-items:center;gap:5px;height:26px;padding:0 9px;'
                   f'background:{bg};color:{fg};font-size:14px;font-weight:700;{notch(2)}">{pre}{name}</span></li>')
    sep = f'<li aria-hidden="true" style="width:10px;height:3px;background:{P["mist"]};"></li>'
    return f'<ol aria-label="流程進度" style="list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px;">{sep.join(out)}</ol>'


def needs_btn(n):
    if n:
        return (f'<a href="#needs" style="display:inline-block;padding:3px;background:{FR};text-decoration:none;{notch(4)}">'
                f'<span style="display:flex;align-items:center;gap:8px;height:34px;padding:0 14px;background:{P["amber"]};color:{FR};font-weight:700;{notch(2)}">'
                f'{BANG}需要你 <span style="font-family:{DOT};font-size:18px;">{n}</span></span></a>')
    return (f'<a href="#needs" style="display:inline-block;padding:3px;background:{P["mist"]};text-decoration:none;{notch(4)}">'
            f'<span style="display:flex;align-items:center;gap:8px;height:34px;padding:0 14px;background:{PAPER};color:{FR};font-weight:700;{notch(2)}">'
            f'需要你 <span style="font-family:{DOT};font-size:18px;">0</span></span></a>')


def toggle():
    out = ""
    for v in ["辦公室", "看板"]:
        on = v == "辦公室"
        out += (f'<button type="button" aria-pressed="{"true" if on else "false"}" style="height:30px;padding:0 12px;border:0;cursor:pointer;font-family:{SANS};font-size:14px;font-weight:700;'
                f'background:{FR if on else PAPER};color:{PAPER if on else FR};{notch(2)}">{v}</button>')
    return f'<div role="group" aria-label="檢視" style="display:flex;gap:2px;padding:3px;background:{FR};{notch(4)}">{out}</div>'


def header(states, needs=0, meta=None):
    meta = meta or [("範本", "需求到 PR"), ("整合分支", "ai-office/w4d9-add-dark-mode-toggle"), ("已執行", "41 分")]
    m = "".join(f'<span style="display:inline-flex;gap:6px;"><span style="color:{MU};">{k}</span><span>{v}</span></span>' for k, v in meta)
    return f'''<header style="display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;padding:14px 24px;background:{PAPER};border-bottom:3px solid {FR};">
  <span style="display:inline-flex;align-items:center;gap:10px;font-family:{DOT};font-size:20px;color:{FR};">{LOGO}AI Office</span>
  <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
    <h1 style="margin:0;font-size:19px;line-height:24px;font-weight:700;">Add dark mode toggle</h1>
    <div style="display:flex;flex-wrap:wrap;gap:2px 16px;font-size:13px;">{m}</div>
  </div>
  <div style="flex:1 1 auto;"></div>
  <div style="display:flex;align-items:center;gap:12px;">{toggle()}{needs_btn(needs)}</div>
</header>
<nav aria-label="流程" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:10px 24px;background:{BG};border-bottom:2px solid {P["mist"]};">
  <span style="font-size:13px;color:{MU};font-weight:700;">流程</span>{stepper(states)}
</nav>'''


def h2(t, extra=""):
    return f'<h2 style="margin:0;font-size:16px;line-height:22px;font-weight:700;{extra}">{t}</h2>'


def needs_panel(title, body, filled=False):
    if filled:
        return panel(f'<div style="display:flex;gap:8px;align-items:center;font-size:17px;font-weight:700;">{BANG}{title}</div><p style="margin:0;font-size:14px;">{body}</p>',
                     bg=P["amber"], label="需要你").replace("<section", '<section id="needs"', 1)
    return panel(f'<div style="display:flex;gap:8px;align-items:center;font-size:17px;font-weight:700;">{title}</div><p style="margin:0;font-size:14px;color:{MU};">{body}</p>',
                 label="需要你", frame=P["amber"]).replace("<section", '<section id="needs"', 1)


def facts(rows):
    out = "".join(f'<div><dt style="font-size:12px;color:{MU};">{k}</dt><dd style="margin:0;font-size:15px;">{v}</dd></div>' for k, v in rows)
    return f'<dl style="margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;line-height:1.35;">{out}</dl>'


def tool_dot(col):
    return f'<span aria-hidden="true" style="display:inline-block;width:9px;height:9px;background:{col};box-shadow:0 0 0 2px {FR};margin:0 4px 0 2px;"></span>'


def portrait(role, vendor, rows=22, bg=P["mist"]):
    return (f'<span style="display:block;width:68px;flex:none;background:{FR};padding:3px;{notch(4)}"><span style="display:block;background:{bg};padding:6px 6px 0;{notch(2)}">'
            f'{char_front(role, vendor, rows).svg()}</span></span>')


def vendor_line(vendor, note):
    return (f'<span style="display:inline-flex;align-items:center;gap:6px;font-size:14px;">{badge(vendor, "12px")}{VENDOR[vendor]["name"]}'
            f'<span style="color:{MU};">{note}</span></span>')


def inspector_integrator():
    acts = "".join(f'<li style="display:flex;justify-content:space-between;gap:8px;"><span>{tool_dot(c)}{a}</span><span style="color:{MU};">{b}</span></li>'
                   for c, a, b in [(P["cyan"], "讀檔 9 次", "1 分前"), (P["orange"], "跑指令 3 次", "2 分前"), (P["cyan"], "fetch worker 分支", "6 分前")])
    hist = "".join(f'<li style="display:flex;gap:10px;"><span style="flex:none;font-family:{DOT};color:{MU};">{a}</span><span>{b}</span></li>'
                   for a, b in [("#1", "要求修改：切換按鈕缺少 aria-pressed；沒處理系統預設主題"), ("#2", "審查中，修正已通過 checks")])
    return panel(f'''<div style="display:flex;gap:12px;align-items:flex-end;">{portrait("integrator", "cc")}
  <div style="display:flex;flex-direction:column;gap:4px;min-width:0;"><span style="font-family:{DOT};font-size:20px;line-height:1.1;">integrator</span>{vendor_line("cc", "整合台")}</div></div>
{facts([("正在做", "審查 PR #5"), ("第幾次", "第 2 次"), ("rework", "1 ／ 2"), ("token", "41k")])}
<div style="display:flex;flex-direction:column;gap:6px;"><h3 style="margin:0;font-size:14px;">最近的動作</h3>
<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:14px;">{acts}</ul></div>
<div style="display:flex;flex-direction:column;gap:6px;"><h3 style="margin:0;font-size:14px;">PR #5 的審查</h3>
<ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px;font-size:14px;line-height:1.45;">{hist}</ol></div>
<form style="display:flex;flex-direction:column;gap:8px;"><label for="msg" style="font-size:14px;font-weight:700;">傳話給 integrator</label>
<textarea id="msg" rows="2" style="font:inherit;font-size:14px;padding:8px;border:3px solid {FR};background:{PAPER};color:{FR};resize:vertical;">合併前確認深色模式下文字對比仍有 4.5:1</textarea>
<div style="display:flex;justify-content:flex-end;">{btn("送出")}</div></form>''', label="選取的 agent")


def usage_panel(rows, total):
    def stack(n):
        c = Canvas(11, 2 * n + 1)
        for i in range(n):
            c.rect(i % 2, 2 * i, 10, 1, P["white"]); c.rect(1 - i % 2, 2 * i + 1, 10, 1, P["mist"])
            c.put(0 if i % 2 else 10, 2 * i, P["steel"])
        return f'<span aria-hidden="true" style="display:inline-block;width:33px;line-height:0;vertical-align:bottom;">{c.svg()}</span>'
    li = "".join(f'<li style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:end;font-size:14px;">'
                 f'<span>{a}</span><span style="text-align:center;">{stack(n)}</span><span style="text-align:right;font-family:{DOT};">{v}</span></li>' for a, n, v in rows)
    return panel(f'''<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">{h2("token 用量")}<span style="font-family:{DOT};font-size:22px;">{total}</span></div>
<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;">{li}</ul>
<p style="margin:0;font-size:12px;color:{MU};">只記用量，不設上限；紙疊越高用得越多。</p>''', label="token 用量")


def legend():
    def sw(col):
        return f'<span aria-hidden="true" style="width:14px;height:10px;background:{col};box-shadow:0 0 0 2px {FR};margin:0 2px;"></span>'
    it = lambda a, b: f'<span style="display:inline-flex;align-items:center;gap:6px;">{a}{b}</span>'
    return (f'<div style="display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;align-items:center;">'
            + it(badge("cc", "12px"), "Claude Code") + it(badge("cx", "12px"), "Codex")
            + it(sw(P["sky"]), "螢幕藍：改檔") + it(sw(P["orange"]), "橘：跑指令") + it(sw(P["cyan"]), "青：讀檔")
            + it(BANG, "需要你") + it(sw(P["red"]), "出錯") + "</div>")


def caption(t):
    return f'<p style="margin:0;font-size:13px;color:{MU};">{t}</p>'


HEAD_TPL = '''<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
''' + FONTS + '''
<style>
''' + STYLE + '''
</style>
</helmet>
'''
TAIL = '''</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1440,"height":%H%}}'>
class Component extends DCLogic {
renderVals() { return { }; }
}
</script>
</body>
</html>
'''


def page(fname, title, body, h):
    root = (f'<div style="width:100%;max-width:1440px;margin:0 auto;min-height:{h}px;background:{BG};color:{FR};'
            f'display:flex;flex-direction:column;box-sizing:border-box;">\n{body}\n</div>\n')
    with open(os.path.join(OUT, fname), "w", encoding="utf-8") as f:
        f.write(HEAD_TPL.replace("{title}", title) + root + TAIL.replace("%H%", str(h)))
    with open(os.path.join(PREV, fname.replace(".dc.html", ".html")), "w", encoding="utf-8") as f:
        f.write(f'<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">{FONTS}<style>{STYLE}</style></head><body>'
                + root.replace(f"min-height:{h}px;", "", 1)
                + '<script>document.fonts.ready.then(()=>{document.body.dataset.h=Math.ceil(document.body.firstElementChild.getBoundingClientRect().height)})</script></body></html>')
    return fname


def main_layout(scene_html, under, right):
    frame = f'<div style="background:{FR};padding:3px;{notch(6)}"><div style="{notch(4)}">{scene_html}</div></div>'
    return f'''<main style="display:flex;flex-wrap:wrap;gap:20px;padding:18px 24px 24px;align-items:flex-start;">
  <div style="flex:0 1 1062px;min-width:0;display:flex;flex-direction:column;gap:12px;">{frame}{under}</div>
  <aside style="flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:16px;">{right}</aside>
</main>'''


IMPL = ["done", "done", "done", "done", "active", "pending", "pending"]


def office():
    right = (needs_panel("需要你：0 件", "沒有要你決定的事。收尾後最終 PR 會送到你的桌上。")
             + inspector_integrator()
             + usage_panel([("會議", 4, "286k"), ("拆分", 2, "142k"), ("實作", 8, "612k")], "1.04M"))
    under = (f'<div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 20px;">{legend()}</div>'
             + caption("點人、座位或門牌放大房間；點白板切到看板。情境是 demo run 加一個平行項目；token 為示意。"))
    body = header(IMPL) + main_layout(scene("implement", "integrator"), under, right)
    return page("V3Office.dc.html", "像素辦公室 實作中", body, HEIGHTS["V3Office.dc.html"])


def meeting():
    st = ["active", "pending", "pending", "pending", "pending", "pending", "pending"]
    li = lambda xs: "".join(f"<li>{x}</li>" for x in xs)
    insp = panel(f'''<div style="display:flex;gap:12px;align-items:flex-end;">{portrait("architect", "cc")}
  <div style="display:flex;flex-direction:column;gap:4px;"><span style="font-family:{DOT};font-size:20px;line-height:1.1;">architect</span>{vendor_line("cc", "會議參與者")}</div></div>
{facts([("第 2 輪", "已發言，可收斂"), ("第 1 輪", "已發言"), ("token", "58k"), ("座位", "會議桌北側")])}
<div style="display:flex;flex-direction:column;gap:6px;"><h3 style="margin:0;font-size:14px;">第 2 輪立場</h3>
<p style="margin:0;font-size:15px;">用 CSS 變數；偏好存 localStorage，免動後端。</p>
<h3 style="margin:4px 0 0;font-size:14px;">理由</h3><ul style="margin:0;padding-left:18px;font-size:14px;">{li(["切換主題不必重新渲染元件樹", "未登入也能保留選擇"])}</ul>
<h3 style="margin:4px 0 0;font-size:14px;">顧慮</h3><ul style="margin:0;padding-left:18px;font-size:14px;">{li(["第一次載入可能閃一下舊主題"])}</ul></div>
<p style="margin:0;font-size:13px;color:{MU};">開會中的 agent 不收傳話；意見請在結論定案時寫進回饋。</p>''', label="選取的 agent")
    right = (needs_panel("需要你：0 件", "會議結束、大家離座後，結論會送到你的桌上。") + insp
             + usage_panel([("會議（進行中）", 5, "214k")], "214k"))
    under = (f'<div style="display:flex;flex-wrap:wrap;gap:8px 20px;">{legend()}</div>'
             + caption("泡泡是每位最新一輪的立場（meeting.statement 的 position），選取中的是 architect。其他房間還沒開工。"))
    body = header(st, meta=[("範本", "需求到 PR"), ("階段", "會議，第 2 輪"), ("已執行", "6 分")]) + main_layout(scene("meeting", "architect"), under, right)
    return page("V3Meeting.dc.html", "像素辦公室 會議中", body, HEIGHTS["V3Meeting.dc.html"])


def gate():
    st = ["done", "open", "pending", "pending", "pending", "pending", "pending"]
    mini = f'<div style="flex:1 1 640px;min-width:0;max-width:760px;background:{FR};padding:3px;{notch(6)}"><div style="{notch(4)}">{scene("gate")}</div></div>'
    lead_in = f'''<div style="flex:1 1 400px;min-width:0;display:flex;flex-direction:column;gap:14px;">
  <h2 style="margin:0;font-size:32px;line-height:40px;font-weight:700;">結論定案在等你</h2>
  <p style="margin:0;font-size:17px;line-height:1.65;max-width:32em;">會議的 4 位都已離座，辦公室只剩你桌上那盞燈。你決定之前，沒有任何 agent 在執行，流程也不會往下走。</p>
  {facts([("已經等了", "3 分 12 秒"), ("關卡版本", "v2，GitHub 上被編輯過"), ("剩下的重開", "2 次"), ("決定後", "lead 開始拆工作項目")])}
</div>'''
    seg = "".join(f'<button type="button" aria-pressed="{"true" if i == 0 else "false"}" style="height:30px;padding:0 10px;border:0;cursor:pointer;font-family:{SANS};font-size:14px;font-weight:700;'
                  f'background:{FR if i == 0 else PAPER};color:{PAPER if i == 0 else FR};{notch(2)}">{v}</button>' for i, v in enumerate(["GitHub 目前版本", "AI Office 原始版本", "差異"]))
    th = f'text-align:left;font-size:13px;color:{MU};padding:6px 10px 6px 0;border-bottom:3px solid {FR};'
    td = 'font-size:15px;padding:8px 10px 8px 0;border-bottom:2px solid #DDE2EA;vertical-align:top;'
    tech = "".join(f'<tr><td style="{td}">{a}</td><td style="{td}color:{MU};">{b}</td><td style="{td}font-weight:700;">{c}</td><td style="{td}">{d}</td></tr>'
                   for a, b, c, d in [("主題的做法", "CSS 變數、CSS-in-JS 主題物件", "CSS 變數", "切換不必重新渲染元件樹"),
                                      ("偏好存在哪", "localStorage、後端使用者設定", "localStorage", "不用改後端，未登入也能用"),
                                      ("語言", "TypeScript", "TypeScript", "和現有程式碼一致")])
    sec = lambda t, b: f'<section style="display:flex;flex-direction:column;gap:6px;"><h3 style="margin:0;font-size:14px;color:{MU};">{t}</h3>{b}</section>'
    doc = panel(f'''<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;">
  <div><h2 style="margin:0;font-size:24px;line-height:30px;">會議結論</h2><a href="#" style="font-size:14px;">在 GitHub 打開 Issue #1</a></div>
  <div role="group" aria-label="版本" style="display:flex;gap:2px;padding:3px;background:{FR};{notch(4)}">{seg}</div></div>
<p style="margin:0;padding:8px 12px;background:#E6EAF1;font-size:14px;">你在 GitHub 上補了一條決策。核准時以 GitHub 目前的版本為準。</p>
{sec("摘要", '<p style="margin:0;font-size:17px;line-height:1.7;max-width:38em;">用 CSS 變數加 ThemeProvider 做深色模式切換；預設跟著系統設定，使用者手動切換後記住選擇。</p>')}
{sec("決策", f"""<ol style="margin:0;padding-left:22px;font-size:16px;line-height:1.7;"><li>範圍是全站主題切換，不做個別元件的自訂配色</li><li>開關放在設定頁，預設跟著系統的 prefers-color-scheme</li>
<li style="background:#E6EAF1;padding:0 8px;margin-left:-8px;box-shadow:inset 4px 0 0 {FR};">第一次載入前先套用已存的主題，避免畫面閃一下 <span style="font-size:13px;color:{MU};">你在 GitHub 新增</span></li></ol>""")}
{sec("技術選型", f'<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;min-width:520px;"><thead><tr><th scope="col" style="{th}">題目</th><th scope="col" style="{th}">考慮過</th><th scope="col" style="{th}">採用</th><th scope="col" style="{th}">原因</th></tr></thead><tbody>{tech}</tbody></table></div>')}
{sec("還沒決定", '<p style="margin:0;font-size:16px;">要不要加第三個選項「跟著系統」，讓使用者能切回自動？</p>')}''', pad="22px 26px 26px", label="會議結論")
    who = "".join(f'<li style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:2px solid #DDE2EA;font-size:14px;">'
                  f'<span style="width:30px;flex:none;line-height:0;">{char_front(r, v, 14).svg()}</span><span style="flex:0 0 96px;font-family:{DOT};">{r}</span><span>{s}</span></li>'
                  for r, v, s in [("lead", "cc", "主持：議題是做法、偏好存哪、範圍"), ("pm", "cc", "開關要有可及性標籤，重新整理後要保留"),
                                  ("architect", "cc", "用 CSS 變數；偏好存 localStorage，免動後端"), ("engineer", "cx", "可拆 3 項；dependent 一定要等 feature 合併")])
    record = panel(f'{h2("第 2 輪誰說了什麼")}<ul style="margin:0;padding:0;list-style:none;">{who}</ul><a href="#" style="font-size:14px;">看兩輪的完整發言</a>', label="會議紀錄")
    decide = (needs_panel("需要你：結論定案", "3 個階段關卡的第 1 個。", filled=True)
              + panel(f'''<div style="display:flex;flex-direction:column;gap:6px;">{btn("核准這份結論", "primary", True)}<span style="font-size:13px;color:{MU};">用 GitHub 目前的版本（v2）。lead 接著拆工作項目。</span></div>
<div style="display:flex;flex-direction:column;gap:6px;">{btn("改了再核准", "secondary", True)}<span style="font-size:13px;color:{MU};">在這裡改，含技術選型，存回 Issue #1。</span></div>
<form style="display:flex;flex-direction:column;gap:8px;border-top:3px dashed {P["mist"]};padding-top:12px;"><label for="fb" style="font-size:15px;font-weight:700;">退回，請會議重開</label>
<textarea id="fb" rows="4" style="font:inherit;font-size:15px;padding:8px;border:3px solid {FR};background:{PAPER};color:{FR};resize:vertical;">請評估加入「跟著系統」第三選項，並說明會多出多少工作。</textarea>
<span style="font-size:13px;color:{MU};">要寫回饋才能退回。還能重開 2 次，用完流程就結束。</span>{btn("退回並重開會議", "danger", True)}</form>''', label="你的決定"))
    body = (header(st, needs=1, meta=[("範本", "需求到 PR"), ("關卡", "結論定案"), ("已執行", "9 分")])
            + f'<div style="display:flex;flex-wrap:wrap;gap:24px 36px;padding:22px 24px 6px;align-items:center;">{mini}{lead_in}</div>'
            + f'<main style="display:flex;flex-wrap:wrap;gap:24px;padding:16px 24px 32px;align-items:flex-start;"><div style="flex:999 1 640px;min-width:0;display:flex;flex-direction:column;gap:20px;">{doc}{record}</div>'
            + f'<aside style="flex:1 1 340px;min-width:0;display:flex;flex-direction:column;gap:16px;">{decide}</aside></main>')
    return page("V3Gate.dc.html", "關卡 結論定案", body, HEIGHTS["V3Gate.dc.html"])


# ------------------------------------------------------------------ sprite sheet
def cell(inner, caption_text, sub="", w=None, bg=P["sand"]):
    return (f'<li style="display:flex;flex-direction:column;gap:6px;min-width:0;"><div style="background:{FR};padding:3px;{notch(4)}">'
            f'<div style="background:{bg};padding:10px;display:flex;align-items:flex-end;justify-content:center;gap:8px;min-height:120px;{notch(2)}">{inner}</div></div>'
            f'<span style="font-size:14px;font-weight:700;">{caption_text}</span>'
            + (f'<span style="font-size:12px;color:{MU};line-height:1.4;">{sub}</span>' if sub else "") + '</li>')


def px(cv, scale):
    return f'<span style="display:block;width:{cv.w * scale}px;flex:none;line-height:0;">{cv.svg()}</span>'


def compose(*parts, w=24, h=36):
    c = Canvas(w, h)
    for cv, x, y in parts:
        for j, row in enumerate(cv.px):
            for i, col in enumerate(row):
                if col:
                    c.put(x + i, y + j, col)
    return c


def desk_cv(state):
    c = Canvas(40, 46)
    from scene3 import desk as dsk
    dsk(c, 0, 12, 40, 14)
    tool = {"working": "edit", "error": "error", "idle": "off", "need": "off", "exited": "off"}[state]
    m = monitor(tool)
    for j, row in enumerate(m.px):
        for i, col in enumerate(row):
            if col:
                c.put(13 + i, 3 + j, col)
    return c


def state_cell(state):
    base = desk_cv(state)
    if state == "working":
        ch = frames_svg([char_back("engineer", "cx", 0), char_back("engineer", "cx", 1)])
        fig = f'<span style="position:absolute;left:30%;top:42%;width:40%;line-height:0;">{ch}</span>'
    elif state == "error":
        fig = (f'<span style="position:absolute;left:30%;top:46%;width:40%;line-height:0;">{char_back("pm", "cc", 0, slump=3).svg()}</span>'
               f'<span style="position:absolute;left:44%;top:-6%;width:34%;line-height:0;">{prop("smoke").svg()}</span>')
    elif state == "idle":
        fig = (f'<span style="position:absolute;left:30%;top:20%;width:40%;line-height:0;">{char_front("architect", "cc", 22, eyes_closed=True).svg()}</span>'
               f'<span style="position:absolute;left:66%;top:52%;width:17%;line-height:0;">{prop("mug").svg()}</span>')
        base = Canvas(40, 46)
        from scene3 import desk as dsk
        for j, row in enumerate(prop("chair_front").px):
            for i, col in enumerate(row):
                if col:
                    base.put(13 + i, 20 + j, col)
        dsk(base, 0, 30, 40, 10)
    elif state == "need":
        fig = (f'<span style="position:absolute;left:62%;top:2%;width:40%;line-height:0;">{char_front("lead", "cc", 32).svg()}</span>'
               f'<span class="px-bob" style="position:absolute;left:69%;top:-26%;width:26%;line-height:0;">{prop("bang").svg()}</span>')
        for j, row in enumerate(prop("lamp_on").px):
            for i, col in enumerate(row):
                if col:
                    base.put(2 + i, 4 + j, col)
    else:
        fig = ""
        for j, row in enumerate(prop("chair_back").px):
            for i, col in enumerate(row):
                if col:
                    base.put(20 + i, 34 + j, col)
    return f'<span style="position:relative;display:block;width:160px;line-height:0;margin-top:34px;">{base.svg()}{fig}</span>'


def sprites_page():
    swatches = "".join(f'<li title="{name}" style="display:flex;flex-direction:column;gap:2px;font-size:11px;font-family:{DOT};">'
                       f'<span style="display:block;height:34px;background:#{hx};box-shadow:inset 0 0 0 2px {FR};"></span>#{hx}</li>' for hx, name in E32.items())
    pal = f'<ul style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(16,minmax(0,1fr));gap:8px;">{swatches}</ul>'
    roles = []
    for r, v in [("lead", "cc"), ("pm", "cc"), ("architect", "cc"), ("engineer", "cx"), ("integrator", "cc"),
                 ("lead", "cx"), ("pm", "cx"), ("architect", "cx"), ("engineer", "cc"), ("integrator", "cx")]:
        roles.append(cell(px(char_front(r, v), 4) + px(char_back(r, v), 4), f"{r}", f'{VENDOR[v]["name"]}（{VENDOR[v]["short"]}）'))
    roles = f'<ul style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;">{"".join(roles)}</ul>'
    states = "".join(cell(state_cell(k), n, d) for k, n, d in [
        ("working", "工作中", "兩格打字動畫；螢幕顏色＝工具（藍改檔、橘跑指令、青讀檔）"),
        ("need", "需要你", "轉身面向你，頭上「!」跳動，桌燈轉琥珀色"),
        ("error", "出錯", "螢幕變紅、冒一縷煙、整個人垮下來"),
        ("idle", "閒著", "往後靠、拿著咖啡、不動"),
        ("exited", "已離座", "空椅子推開，螢幕關掉")])
    states = f'<ul style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;">{states}</ul>'
    props = [("plant", "盆栽"), ("cactus", "窗台仙人掌"), ("chair_front", "椅子（正面）"), ("chair_back", "椅子（背面）"), ("mon_back", "螢幕背面"),
             ("printer", "印表機"), ("tray", "交件匣"), ("coffee", "咖啡機"), ("mug", "馬克杯"), ("lamp_off", "桌燈"), ("lamp_on", "桌燈（等你）"),
             ("clock", "時鐘（靜止）"), ("trash", "垃圾桶"), ("corkboard", "軟木板"), ("box", "PR 包裹"), ("jacket", "外套")]
    pr = "".join(cell(px(prop(k), 4), n, bg=P["sand"]) for k, n in props)
    pr += "".join(cell(px(monitor(s), 4), f"螢幕：{n}") for s, n in [("edit", "改檔"), ("bash", "跑指令"), ("read", "讀檔"), ("error", "出錯"), ("off", "關")])
    props_html = f'<ul style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:14px;">{pr}</ul>'
    # effects
    env = (f'<span style="position:relative;display:block;width:170px;height:80px;">'
           + "".join(f'<span aria-hidden="true" style="position:absolute;left:{x}px;top:{y}px;width:6px;height:6px;background:{FR};opacity:{o};"></span>' for x, y, o in [(8, 62, .3), (30, 52, .45), (52, 42, .6), (74, 34, .75)])
           + f'<span style="position:absolute;left:96px;top:10px;width:66px;transform:rotate(-12deg);line-height:0;">{prop("envelope").svg()}</span></span>')
    printing = Canvas(16, 22)
    for j, row in enumerate(prop("printer").px):
        for i, col in enumerate(row):
            if col:
                printing.put(i, j, col)
    printing.rect(4, 12, 8, 9, P["white"]); printing.rect(5, 14, 6, 1, P["slate"]); printing.rect(5, 16, 5, 1, P["slate"]); printing.rect(5, 18, 6, 1, P["slate"])
    conv = Canvas(64, 22)
    conv.rect(0, 8, 64, 2, P["steel"]); conv.rect(0, 18, 64, 2, P["steel"]); conv.rect(0, 10, 64, 8, P["ink"])
    for x in range(1, 64, 5):
        conv.rect(x, 10, 1, 8, P["dusk"])
    for j, row in enumerate(prop("box").px):
        for i, col in enumerate(row):
            if col:
                conv.put(26 + i, 2 + j, col)
    merge = compose((prop("box"), 6, 14), (prop("confetti"), 0, 0), w=24, h=24)
    fx = "".join([cell(env, "訊息信封", "經 AI Office 轉送的協調訊息；有事件才飛，留下虛線軌跡"),
                  cell(px(printing, 4), "印表機出紙", "開出 PR 時印一張"),
                  cell(px(conv, 3), "合併佇列輸送帶", "PR 包裹往整合台移動；有 PR 進佇列才動"),
                  cell(px(merge, 4), "合併成功", "包裹落進整合分支時灑一次彩紙"),
                  cell(px(prop("bang"), 5), "「!」需要你", "唯一一直跳的提醒"),
                  cell(px(prop("smoke"), 5), "出錯冒煙", "只在錯誤時出現")])
    fx = f'<ul style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px;">{fx}</ul>'
    tags = (f'<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;container-type:inline-size;">'
            + tag("persist", "實作中 12 分　148k", "cx") + tag("integrator", "審查 PR #5　第 2 次", "cc", "selected") + tag("結論定案", "等你 3 分 12 秒", mode="need")
            + needs_btn(0) + needs_btn(1) + btn("核准這份結論") + btn("改了再核准", "secondary") + btn("退回並重開會議", "danger") + "</div>")
    S = lambda t, note, b: (f'<section style="display:flex;flex-direction:column;gap:14px;"><div style="display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;">'
                            f'{h2(t, "font-size:22px;line-height:28px;")}<span style="font-size:14px;color:{MU};">{note}</span></div>{b}</section>')
    body = (f'<header style="display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;padding:24px 32px 6px;">'
            f'<span style="display:inline-flex;align-items:center;gap:10px;font-family:{DOT};font-size:20px;">{LOGO}AI Office</span>'
            f'<h1 style="margin:0;font-size:32px;line-height:40px;">精靈圖與樣式表</h1>'
            f'<p style="margin:0;font-size:15px;color:{MU};">16 px 格、角色 16×32、整數倍放大。全部自己畫，色盤用 Endesga 32。</p></header>'
            f'<main style="display:flex;flex-direction:column;gap:36px;padding:20px 32px 40px;">'
            + S("色盤", "Endesga 32；黃（amber）只給「需要你」，紅只給錯誤", pal)
            + S("角色", "職位固定長相，廠牌只換襯衫與徽章：Claude Code 天藍＋白徽章，Codex 草綠＋深色徽章", roles)
            + S("五種狀態", "狀態只畫在人和桌子上，不另外加圖示", states)
            + S("家具與小物", "約 20 件，全部 16 px 格", props_html)
            + S("事件效果", "只在真的事件發生時播放；減少動態時全部停住", fx)
            + S("名牌、門牌與按鈕", "介面只借像素邊框；內文用 Noto Sans TC，英數用 DotGothic16", tags)
            + "</main>")
    return page("V3Sprites.dc.html", "精靈圖與樣式表", body, HEIGHTS["V3Sprites.dc.html"])


HEIGHTS = {"V3Office.dc.html": 1150, "V3Meeting.dc.html": 980, "V3Gate.dc.html": 1650, "V3Sprites.dc.html": 2250}

if __name__ == "__main__":
    for f in (office, meeting, gate, sprites_page):
        print(f())
