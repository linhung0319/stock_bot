# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools>=4.50", "brotli"]
# ///
"""做網站標題用的明體字型檔：public/fonts/display.woff2。

用法（在 worker/ 底下）：
    uv run scripts/build-font.py

做的事：
  1. 掃 public/ 和 src/ 裡所有出現過的字（畫面上的字都寫在這兩個地方）。
  2. 從思源宋體（Noto Serif TC，SIL OFL 授權）只取出這些字，粗細留 600–900。
  3. 存成 woff2，放在 public/fonts/，網站自己提供，不連到別的網站拿字型。

什麼時候要重跑：標題、按鈕、通知標題用了新的字之後。沒重跑也不會壞——
缺的字會改用系統的黑體顯示，只是那幾個字的樣子和旁邊不同。
原始字型檔很大（約 17 MB），不放進版本庫；第一次跑會下載到 .font-cache/。
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SOURCE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf"
LICENSE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notoseriftc/OFL.txt"
CACHE = ROOT / ".font-cache"
OUT = ROOT / "public" / "fonts"
SCAN = [(ROOT / "public", {".js", ".html"}), (ROOT / "src", {".ts"})]
# 程式裡不一定出現、但標題可能用到的符號與數字
ALWAYS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,:;!?%$+-−–—/()[]#&'\"‘’“”…·・、。，：；！？（）「」『』《》〈〉％＋－／～"


def used_chars() -> set[str]:
    chars = set(ALWAYS)
    for folder, exts in SCAN:
        for f in folder.rglob("*"):
            if f.is_file() and f.suffix in exts:
                chars.update(ch for ch in f.read_text(encoding="utf-8") if ord(ch) > 0x2000)
    return chars


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"下載 {url}")
        urllib.request.urlretrieve(url, dest)
    return dest


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else fetch(SOURCE_URL, CACHE / "NotoSerifTC-wght.ttf")
    chars = used_chars()
    font = TTFont(src)
    opt = Options()
    opt.flavor = "woff2"
    opt.layout_features = ["kern", "liga", "palt", "locl", "ccmp", "mark", "mkmk"]
    opt.hinting = False
    opt.desubroutinize = True
    opt.name_IDs = [1, 2, 3, 4, 6, 13, 14]
    opt.notdef_outline = True
    sub = Subsetter(opt)
    sub.populate(text="".join(sorted(chars)))
    sub.subset(font)
    # 先取字再收窄粗細範圍（反過來做，fontTools 會找不到字形）
    font = instancer.instantiateVariableFont(font, {"wght": (600, 900)})
    cmap = font.getBestCmap()
    missing = sorted(ch for ch in chars if ord(ch) not in cmap and not ch.isspace())
    OUT.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff2"
    out = OUT / "display.woff2"
    font.save(out)
    lic = fetch(LICENSE_URL, CACHE / "OFL.txt")
    (OUT / "OFL.txt").write_text(lic.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"{out.relative_to(ROOT)}：{len(chars)} 個字，{out.stat().st_size / 1024:.0f} KB")
    if missing:
        print(f"字型裡沒有、會改用系統字顯示的 {len(missing)} 個：{''.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
