"""在 repo 裡討論自選股的論點（計畫 T48；設計 own_thesis §1.7、§1.8）：向 Worker 取討論包、預覽、回填。

    uv run python scripts/thesis.py list                 # 自選清單：有沒有論點、有沒有還沒回覆的「前提不成立」通知
    uv run python scripts/thesis.py pull MU NVDA         # 取討論包，存成 records/thesis/<代號>/pack.md
    uv run python scripts/thesis.py pull --all           # 全部自選
    uv run python scripts/thesis.py preview MU           # 讀 records/thesis/MU/block.md（收尾的區塊），只預覽、不存
    uv run python scripts/thesis.py save MU --confirmed  # 存檔（使用者看過預覽、說可以之後才加 --confirmed）

- 給 Claude Code 的 /thesis 指令用（.claude/commands/thesis.md）；自己手動跑也可以。
- 論點是和使用者討論出來的：save 之前一定先 preview 給使用者看，使用者同意才存。
- 這條路不回覆通知（「這是對通知的回應」留在網站的編輯論點頁做），也不勾選出場條件的改寫結果（在持股頁確認）。
- ADMIN_TOKEN、Worker 網址的找法和 export_records.py 相同；可用 --url 指到本機的 wrangler dev。
- repo 是公開的：討論包與區塊只寫進被 .gitignore 擋掉的資料夾（預設 records/thesis/）。
只用標準函式庫。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from export_records import REPO, admin_token, ensure_ignored, site_url, write_text

USER_AGENT = "stock-bot-thesis/1"
ACTION = {"EXIT": "出清", "HALF": "減半", "REVIEW": "重新審查"}


class Api:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self._token = token

    def call(self, method: str, path: str, params: dict[str, str] | None = None, body: dict | None = None) -> dict:
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {self._token}", "User-Agent": USER_AGENT, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{self.base}/admin/own/{path}{q}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 不印 token；回應是 Worker 的錯誤訊息
            text = e.read().decode("utf-8", "replace")[:500]
            try:
                text = json.loads(text).get("error", text)
            except (ValueError, AttributeError):
                pass
            raise SystemExit(f"/admin/own/{path} 回 HTTP {e.code}：{text}") from None
        except urllib.error.URLError as e:
            raise SystemExit(f"連不上 {self.base}：{e.reason}") from None


def out(msg: str = "") -> None:
    print(msg, flush=True)


def cmd_list(api: Api) -> None:
    r = api.call("GET", "list")
    out(f"自選清單（訊號日 {r['date']}）")
    if not r["own"]:
        out("  （沒有自選股）")
    for o in r["own"]:
        state = "還沒有論點（只有系統預設前提）" if o["kind"] == "DEFAULT_ONLY" else f"有論點（第 {o['thesisVersion']} 版，{o['thesisSetAt']} 定）" if o["thesisVersion"] else "有自己的前提，還沒有論點本文"
        brk = f"；有還沒回覆的「前提不成立」通知 #{o['pendingBreak']}（回覆要在網站上做）" if o["pendingBreak"] is not None else ""
        out(f"  {o['ticker']}：{state}{brk}")


def cmd_pull(api: Api, root: Path, tickers: list[str], everything: bool) -> None:
    if everything:
        tickers = [o["ticker"] for o in api.call("GET", "list")["own"]]
    if not tickers:
        raise SystemExit("沒有要取的代號：給代號，或用 --all")
    for t in tickers:
        r = api.call("GET", "discussion", {"ticker": t})
        path = root / t.upper() / "pack.md"
        write_text(path, r["text"].rstrip("\n") + "\n")
        out(f"{t.upper()}：討論包（情境 {r['mode']}，{len(r['text'])} 字）→ {path}")


def load_block(api: Api, root: Path, ticker: str, block: str | None) -> tuple[dict, dict]:
    """讀收尾的區塊 → 請 Worker 解析 → 回傳 (解析結果, 要送去存的內容)。"""
    path = Path(block) if block else root / ticker / "block.md"
    if not path.exists():
        raise SystemExit(f"找不到 {path}：先把收尾時的區塊（===STOCKBOT 論點 v3 {ticker}=== 到 ===END===）存到這個檔案")
    parsed = api.call("POST", "thesis/parse", body={"ticker": ticker, "text": path.read_text(encoding="utf-8")})
    if parsed.get("error"):
        raise SystemExit(f"區塊被擋下：{parsed['error']}")
    if not parsed.get("found"):
        raise SystemExit(f"{path} 裡沒有找到固定格式的區塊（===STOCKBOT 論點 v3 {ticker}=== 到 ===END===）")
    payload = {
        "ticker": ticker,
        "thesis": parsed["thesis"],
        "premises": [{"id": pid, "text": text} for text, pid in zip(parsed["premises"], parsed["premiseIds"])],
        "exitConditions": [{"text": e["text"], "action": e["action"]} for e in parsed["exits"]],
    }
    return parsed, payload


def show(parsed: dict, payload: dict, res: dict, saved: bool) -> None:
    p = res["preview"]
    out(f"## {payload['ticker']}：{'已存檔' if saved else '預覽（還沒存）'}，論點第 {p['version']} 版")
    out()
    out("論點：")
    out(f"  {payload['thesis'] or '（沒有寫）'}")
    out()
    out("前提：")
    edited = {e["id"]: e for e in p.get("edited", [])}
    for k in p["kept"]:
        if k["id"] in edited:
            e = edited[k["id"]]
            out(f"  沿用 {k['id']}，但字改了（之前的檢查結果接著算；隔天重新審查）")
            out(f"      原本：{e['before']}")
            out(f"      改成：{e['after']}")
        else:
            out(f"  沿用 {k['id']}：{k['text']}")
    for a in p["added"]:
        out(f"  新的 {a['id']}：{a['text']}")
    for r in p["retired"]:
        out(f"  會撤下 {r['id']}{'（系統預設）' if r.get('origin') == 'SYSTEM_DEFAULT' else ''}：{r['text']}")
    if p.get("defaultOnly"):
        out("  沒有寫自己的前提：AI 照樣用系統預設的三條前提檢查，這檔仍算還沒有論點")
    if p.get("silenceEnded"):
        out(f"  {'、'.join(p['silenceEnded'])} 正在靜默期，字改了：存檔後靜默期結束")
    if p.get("changed"):
        out("  前提有增減或字改了：" + ("30 天內已經開過論點變動後的審查，這次的改動留到月底檢查點審" if p.get("reviewHeld") else "隔天的每日流程會開一次審查（每檔 30 天最多 1 次）"))
    out()
    out("出場條件（存檔後要的完整清單）：")
    for e in payload["exitConditions"]:
        out(f"  {e['text']} → {ACTION.get(e['action'], e['action'])}")
    if not payload["exitConditions"]:
        out("  （沒有）")
    ex = p["exits"]
    if not ex["changed"]:
        out(f"  和現在監測中的 {ex['live']} 條相同：照舊監測，不用送 AI")
        for a in ex.get("actionChanged", []):
            out(f"  只改成立時的動作：{a['text']}（{ACTION.get(a['was'], a['was'])} → {ACTION.get(a['action'], a['action'])}）")
    elif payload["exitConditions"]:
        out(f"  有改動：存檔後送 AI 對照與改寫，回來後要在網站的持股頁確認；確認之前，現在的 {ex['live']} 條照舊監測")
    else:
        out(f"  全部拿掉：存檔後要在網站的持股頁確認才撤下；確認之前，現在的 {ex['live']} 條照舊監測")
    if ex.get("pendingVersion"):
        out(f"  第 {ex['pendingVersion']} 版存的出場條件改動還沒在持股頁確認；這次存檔後以這一版為準")
    if parsed.get("conclusion"):
        out()
        out(f"這次的結論：{parsed['conclusion']}（理由：{parsed.get('reason') or '沒寫'}）。只是紀錄，不會自動做任何事")
    for n in parsed.get("notes", []):
        out(f"注意：{n}")
    if saved:
        out()
        rw = res.get("rewrite", {})
        if rw.get("status") == "SENT":
            out(f"出場條件已送去改寫（{rw.get('runId')}）。改寫回來後到網站的持股頁勾選確認，才會開始監測。")
        elif rw.get("status") == "FAILED":
            out(f"出場條件沒有送去改寫：{rw.get('error')}。到網站的持股頁按「重送」。")
        for e in res.get("conds", {}).get("errors", []):
            out(f"注意：{e}")


def main() -> None:
    # 錯誤訊息（SystemExit）走 stderr：兩個都改成 UTF-8，Windows 的終端機才不會變成亂碼
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="自選股論點：取討論包、預覽、回填（給 Claude Code 的 /thesis 用）")
    ap.add_argument("--url", default=None, help="Worker 網址（預設 wrangler.jsonc 的 SITE_URL）")
    ap.add_argument("--out", default=str(REPO / "records" / "thesis"), help="討論包與區塊的資料夾（預設 records/thesis/）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="自選清單")
    sp = sub.add_parser("pull", help="取討論包")
    sp.add_argument("tickers", nargs="*")
    sp.add_argument("--all", action="store_true", help="全部自選")
    for name, text in (("preview", "只預覽、不存"), ("save", "存檔")):
        s = sub.add_parser(name, help=text)
        s.add_argument("ticker")
        s.add_argument("--block", default=None, help="收尾區塊的檔案（預設 <out>/<代號>/block.md）")
        if name == "save":
            s.add_argument("--confirmed", action="store_true", help="使用者看過預覽、同意存檔")
    args = ap.parse_args()

    root = Path(args.out)
    ensure_ignored(root)
    api = Api(args.url or site_url(), admin_token())
    if args.cmd == "list":
        cmd_list(api)
    elif args.cmd == "pull":
        cmd_pull(api, root, args.tickers, args.all)
    else:
        ticker = args.ticker.upper()
        if args.cmd == "save" and not args.confirmed:
            raise SystemExit("還沒存：先跑 preview 給使用者看，使用者同意之後再加 --confirmed")
        parsed, payload = load_block(api, root, ticker, args.block)
        res = api.call("POST", "thesis", body={**payload, "dry": args.cmd == "preview"})
        show(parsed, payload, res, saved=args.cmd == "save")


if __name__ == "__main__":
    main()
