# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools>=4.50", "brotli"]
# ///
"""做網站用的字型檔（網站自己提供，不連到別的網站拿字型）：

  public/fonts/geist.woff2      數字和英文（Geist，粗細 400–700）
  public/fonts/tc-ui.woff2      中文：程式裡出現過的字（畫面上的固定文字幾乎都在這裡），進頁面就載入
  public/fonts/tc-NN.woff2      中文：其他的字，照 Google Fonts 的切法分成幾十片，
                                畫面上真的出現那一片裡的字（例如你寫的前提、AI 的內容）才下載
  public/fonts/fonts.css        上面這些檔案的 @font-face（含 unicode-range）

用法（在 worker/ 底下）：
    uv run scripts/build-font.py

做的事：
  1. 下載思源黑體（Noto Sans TC）與 Geist 的可變字型（都是 SIL OFL 授權），存在 .font-cache/。
  2. 下載 Google Fonts 的 CSS，只用它的 unicode-range 切法（照字的常用程度分片）；字型檔是自己從原始檔切的。
  3. 掃 public/ 和 src/ 裡所有出現過的中文字，做成 tc-ui；其他的字照切法分片（不含 tc-ui 已經有的字）。

什麼時候要重跑：畫面上的固定文字用了新的字之後。沒重跑也不會壞——
那幾個字會落在某一片 tc-NN 裡，用到時多下載那一片而已。
"""
from __future__ import annotations

import re
import sys
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
GF = "https://raw.githubusercontent.com/google/fonts/main/ofl"
SOURCES = {
    "tc": (f"{GF}/notosanstc/NotoSansTC%5Bwght%5D.ttf", f"{GF}/notosanstc/OFL.txt"),
    "geist": (f"{GF}/geist/Geist%5Bwght%5D.ttf", f"{GF}/geist/OFL.txt"),
}
SLICES_CSS = "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400..700&display=swap"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
CACHE = ROOT / ".font-cache"
OUT = ROOT / "public" / "fonts"
SCAN = [(ROOT / "public", {".js", ".html", ".css"}), (ROOT / "src", {".ts"})]
WGHT = (400, 700)
# 中文字型只管這個碼位以上（中日韓的字與全形標點）；英文、數字、一般標點交給 Geist
CJK_FROM = 0x2E80
# 程式裡不一定出現、但畫面上一定會用到的全形標點
ALWAYS = "、。，：；！？（）「」『』《》〈〉％＋－／～・"
# Geist 要留的字：英文、數字、標點、常用符號
GEIST_RANGES = [(0x20, 0x7E), (0xA0, 0xFF), (0x2010, 0x2027), (0x2030, 0x205E), (0x2190, 0x2193), (0x2212, 0x2212), (0x20AC, 0x20AC)]


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"下載 {url}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req) as r:
            dest.write_bytes(r.read())
    return dest


def used_cjk() -> set[int]:
    cps = {ord(c) for c in ALWAYS}
    for folder, exts in SCAN:
        for f in folder.rglob("*"):
            if f.is_file() and f.suffix in exts and f.parent.name != "fonts":
                cps.update(ord(ch) for ch in f.read_text(encoding="utf-8") if ord(ch) >= CJK_FROM)
    return cps


def parse_ranges(text: str) -> list[set[int]]:
    """Google Fonts CSS 裡每一個 @font-face 的 unicode-range。"""
    out = []
    for block in re.findall(r"unicode-range:\s*([^;]+);", text):
        cps: set[int] = set()
        for part in block.split(","):
            part = part.strip().upper().removeprefix("U+")
            if "-" in part:
                a, b = part.split("-")
                cps.update(range(int(a, 16), int(b, 16) + 1))
            elif part:
                cps.add(int(part, 16))
        out.append(cps)
    return out


def subset(src: Path, cps: set[int], dest: Path, features: list[str]) -> int:
    font = TTFont(src)
    opt = Options()
    opt.flavor = "woff2"
    opt.layout_features = features
    opt.hinting = False
    opt.desubroutinize = True
    opt.name_IDs = [1, 2, 3, 4, 6, 13, 14]
    opt.notdef_outline = False
    sub = Subsetter(opt)
    sub.populate(unicodes=sorted(cps))
    sub.subset(font)
    # 先取字再收窄粗細範圍（反過來做，fontTools 會找不到字形）
    font = instancer.instantiateVariableFont(font, {"wght": WGHT})
    font.flavor = "woff2"
    font.save(dest)
    return dest.stat().st_size


def urange(cps: set[int]) -> str:
    """把碼位寫成 unicode-range（連續的合成一段）。"""
    xs = sorted(cps)
    out = []
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[j + 1] == xs[j] + 1:
            j += 1
        out.append(f"U+{xs[i]:X}" if i == j else f"U+{xs[i]:X}-{xs[j]:X}")
        i = j + 1
    return ", ".join(out)


def face(family: str, file: str, cps: set[int]) -> str:
    return f"@font-face {{ font-family: '{family}'; font-style: normal; font-weight: {WGHT[0]} {WGHT[1]}; font-display: swap; src: url('/fonts/{file}') format('woff2'); unicode-range: {urange(cps)}; }}\n"


def main() -> int:
    tc = fetch(SOURCES["tc"][0], CACHE / "NotoSansTC-wght.ttf")
    geist = fetch(SOURCES["geist"][0], CACHE / "Geist-wght.ttf")
    css_src = fetch(SLICES_CSS, CACHE / "notosanstc-slices.css").read_text(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    for old in list(OUT.glob("tc-*.woff2")) + [OUT / "display.woff2"]:
        old.unlink(missing_ok=True)

    lines = ["/* 由 scripts/build-font.py 產生，不要手改。思源黑體（Noto Sans TC）與 Geist，SIL Open Font License（見 OFL-*.txt）。 */\n"]
    sizes: dict[str, int] = {}

    gcmap = set(TTFont(geist).getBestCmap())
    gcps = {c for a, b in GEIST_RANGES for c in range(a, b + 1)} & gcmap
    sizes["geist.woff2"] = subset(geist, gcps, OUT / "geist.woff2", ["kern", "liga", "tnum", "ss01", "case"])
    lines.append(face("Geist", "geist.woff2", gcps))

    cmap = set(TTFont(tc).getBestCmap())
    ui = used_cjk() & cmap
    sizes["tc-ui.woff2"] = subset(tc, ui, OUT / "tc-ui.woff2", ["kern", "palt", "locl", "ccmp"])
    lines.append(face("Noto Sans TC", "tc-ui.woff2", ui))
    covered = set(ui)
    k = 0
    for cps in parse_ranges(css_src):
        rest = {c for c in cps if c >= CJK_FROM} & cmap - covered
        if not rest:
            continue
        name = f"tc-{k:02d}.woff2"
        sizes[name] = subset(tc, rest, OUT / name, ["kern", "palt", "locl", "ccmp"])
        lines.append(face("Noto Sans TC", name, rest))
        covered |= rest
        k += 1
    (OUT / "fonts.css").write_text("".join(lines), encoding="utf-8")
    for key, (_, lic) in SOURCES.items():
        (OUT / f"OFL-{key}.txt").write_text(fetch(lic, CACHE / f"OFL-{key}.txt").read_text(encoding="utf-8"), encoding="utf-8")
    (OUT / "OFL.txt").unlink(missing_ok=True)

    total = sum(sizes.values())
    print(f"geist.woff2：{sizes['geist.woff2'] / 1024:.0f} KB（{len(gcps)} 個字）")
    print(f"tc-ui.woff2：{sizes['tc-ui.woff2'] / 1024:.0f} KB（程式裡的 {len(ui)} 個中文字）")
    others = [v for n, v in sizes.items() if n.startswith("tc-") and n != "tc-ui.woff2"]
    print(f"其他 {len(others)} 片：合計 {sum(others) / 1024 / 1024:.1f} MB，每片 {min(others) / 1024:.0f}–{max(others) / 1024:.0f} KB；共 {len(covered)} 個中文字")
    print(f"全部 {total / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
