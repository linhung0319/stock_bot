"""把 Worker（Cloudflare D1）的紀錄拉到本機（實作計畫 T13；格式見 docs/analysis/records_guide.md）。

    uv run python scripts/export_records.py            # 增量：只增加的表從上次的位置接著拉，其他表整張重拉
    uv run python scripts/export_records.py --full     # 全部重拉
    uv run python scripts/export_records.py --out records/pre-launch --full

- ADMIN_TOKEN：先找環境變數 STOCKBOT_ADMIN_TOKEN，沒有就讀 worker/.secrets.json。不會印出來。
- Worker 網址取 worker/wrangler.jsonc 的 SITE_URL，可用 --url 覆寫（例如本機的 http://127.0.0.1:8787）。
- repo 是公開的：輸出的資料夾必須被 .gitignore 擋掉（records/ 已經列進去），否則不寫。
只用標準函式庫。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKER = REPO / "worker"
# 只增加的表：增量時往回多拉幾列再去重（流程紀錄是先寫一列、同一個請求裡再補內容）
OVERLAP = 5
USER_AGENT = "stock-bot-export/1"


def log(msg: str) -> None:
    print(msg, flush=True)


def site_url() -> str:
    text = (WORKER / "wrangler.jsonc").read_text(encoding="utf-8")
    m = re.search(r'"SITE_URL"\s*:\s*"([^"]+)"', text)
    if not m:
        raise SystemExit("worker/wrangler.jsonc 裡找不到 SITE_URL；請用 --url 指定")
    return m.group(1)


def admin_token() -> str:
    tok = os.environ.get("STOCKBOT_ADMIN_TOKEN", "").strip()
    if tok:
        return tok
    path = WORKER / ".secrets.json"
    if path.exists():
        tok = str(json.loads(path.read_text(encoding="utf-8")).get("ADMIN_TOKEN", "")).strip()
        if tok:
            return tok
    raise SystemExit("找不到 ADMIN_TOKEN：請設環境變數 STOCKBOT_ADMIN_TOKEN，或放在 worker/.secrets.json")


class Client:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self._token = token

    def get(self, params: dict[str, str | int] | None = None) -> dict:
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        req = urllib.request.Request(f"{self.base}/admin/export{q}", headers={"Authorization": f"Bearer {self._token}", "User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 不印 token；回應內容只是錯誤代碼
            body = e.read().decode("utf-8", "replace")[:300]
            raise SystemExit(f"/admin/export{q} 回 HTTP {e.code}：{body}") from None
        except urllib.error.URLError as e:
            raise SystemExit(f"連不上 {self.base}：{e.reason}") from None

    def pull(self, table: str, after: int) -> list[dict]:
        rows: list[dict] = []
        while True:
            page = self.get({"table": table, "after": after})
            rows.extend(page["rows"])
            after = page["next_after"]
            if page["done"]:
                return rows


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    tmp.replace(path)


def write_json(path: Path, data: object) -> None:
    write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    write_text(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))


def dedupe(rows: list[dict], key: str) -> list[dict]:
    """同一個鍵留 rowid 最大的那列（INSERT OR REPLACE 會換 rowid），照 rowid 排。"""
    best: dict[object, dict] = {}
    for r in rows:
        k = r.get(key) if key != "_rowid" else r["_rowid"]
        if k not in best or r["_rowid"] > best[k]["_rowid"]:
            best[k] = r
    return sorted(best.values(), key=lambda r: r["_rowid"])


def pull_table(client: Client, name: str, info: dict, prev: dict | None, raw_dir: Path, full: bool) -> tuple[list[dict], str]:
    """回傳 (這張表在本機的全部列, 怎麼拉的)。"""
    key = info.get("key", "_rowid")
    local = read_jsonl(raw_dir / f"{name}.jsonl")
    if full or info["mode"] != "append" or prev is None or not local:
        return dedupe(client.pull(name, 0), key), "full"
    prev_last = int(prev.get("last_rowid", 0))
    if info["last_rowid"] < prev_last:
        log(f"  {name}：Worker 的最後 rowid（{info['last_rowid']}）比上次（{prev_last}）小，表被清過 → 整張重拉")
        return dedupe(client.pull(name, 0), key), "full (reset)"
    start = max(0, prev_last - OVERLAP)
    fresh = client.pull(name, start)
    merged = {r["_rowid"]: r for r in local if r["_rowid"] <= start}
    for r in fresh:
        merged[r["_rowid"]] = r
    rows = dedupe(list(merged.values()), key)
    # 對帳：概要那一刻的列數要對得上，不對（例如中間有列被刪）就整張重拉
    seen = sum(1 for r in rows if r["_rowid"] <= info["last_rowid"])
    if seen != info["rows"]:
        log(f"  {name}：本機 {seen} 列、Worker {info['rows']} 列，對不上 → 整張重拉")
        return dedupe(client.pull(name, 0), key), "full (mismatch)"
    return rows, f"incremental from rowid {start}"


# ---------------------------------------------------------------- 展開


def safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)[:120] or "_"


def expand_ai_runs(out: Path, raw: dict[str, list[dict]]) -> int:
    root = out / "ai_runs"
    if root.exists():
        shutil.rmtree(root)
    tasks = {t["id"]: t for t in raw.get("ai_tasks", [])}
    rejected: dict[str, list[dict]] = {}
    for r in raw.get("ai_rejections", []):
        rejected.setdefault(r["task_id"], []).append(r)
    n = 0
    for run in raw.get("ai_runs", []):
        d = root / safe_name(run["run_id"])
        task = tasks.get(run.get("task_id") or "")
        meta = {
            "run_id": run["run_id"],
            "fn": run.get("fn"),
            "ticker": run.get("ticker"),
            "as_of": run.get("as_of"),
            "prompt_version": run.get("prompt_version"),
            "repo_commit": run.get("repo_commit"),  # T13 之前的紀錄沒有
            "status": run.get("status"),
            "created_at": run.get("created_at"),
            "completed_at": run.get("completed_at"),
            "applied_at": run.get("applied_at"),
            "pack_hash": run.get("pack_hash"),
            "pack_notes": run.get("pack_notes") or [],
            "task": None
            if not task
            else {k: task.get(k) for k in ("id", "status", "error", "session_url", "created_at", "fired_at", "fetched_at", "completed_at")},
        }
        write_json(d / "meta.json", meta)
        write_json(d / "pack.json", run.get("pack"))
        write_json(d / "outcome.json", run.get("outcome"))
        write_json(d / "process.json", run.get("process") or [])
        rej = rejected.get(run.get("task_id") or "", [])
        if rej:
            items = []
            for r in rej:
                item = {k: r.get(k) for k in ("at", "status", "reason", "http_status", "raw_bytes", "truncated")}
                try:
                    item["raw"] = json.loads(r["raw"])
                    item["raw_is_json"] = True
                except (ValueError, TypeError):
                    item["raw"] = r.get("raw")
                    item["raw_is_json"] = False
                items.append(item)
            write_json(d / "rejected.json", items)
        n += 1
    return n


def expand_prices(out: Path, raw: dict[str, list[dict]]) -> int:
    root = out / "prices"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    n = 0
    for row in raw.get("price_series", []):
        bars = row.get("bars")
        if not isinstance(bars, dict):
            continue
        with (root / f"{safe_name(row['ticker'])}.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "close", "adj_close", "volume"])
            d, c, a, v = (bars.get(k) or [] for k in ("d", "c", "a", "v"))
            for i, day in enumerate(d):
                w.writerow([day, *(x[i] if i < len(x) and x[i] is not None else "" for x in (c, a, v))])
        n += 1
    return n


# ---------------------------------------------------------------- 主程式


def ensure_ignored(out: Path) -> None:
    """輸出在 repo 裡面時，必須被 .gitignore 擋掉（repo 是公開的）。"""
    try:
        out.resolve().relative_to(REPO)
    except ValueError:
        return
    probe = out.resolve() / "manifest.json"
    r = subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", str(probe)], capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f"{out} 沒有被 .gitignore 擋掉；repo 是公開的，紀錄不能放在會被 commit 的地方")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="把 Worker 的紀錄匯出到本機（records/）")
    ap.add_argument("--full", action="store_true", help="全部重拉（不用上次的位置）")
    ap.add_argument("--out", default=str(REPO / "records"), help="輸出資料夾（預設 repo 根目錄的 records/）")
    ap.add_argument("--url", default=None, help="Worker 網址（預設 wrangler.jsonc 的 SITE_URL）")
    args = ap.parse_args()

    out = Path(args.out)
    ensure_ignored(out)
    base = args.url or site_url()
    client = Client(base, admin_token())
    log(f"從 {base} 匯出到 {out}{'（全部重拉）' if args.full else ''}")

    meta = client.get()
    prev_manifest = {}
    mpath = out / "manifest.json"
    if mpath.exists() and not args.full:
        prev_manifest = json.loads(mpath.read_text(encoding="utf-8"))
    prev_tables = prev_manifest.get("tables", {})

    raw_dir = out / "raw"
    raw: dict[str, list[dict]] = {}
    tables: dict[str, dict] = {}
    for name, info in meta["tables"].items():
        rows, how = pull_table(client, name, info, prev_tables.get(name), raw_dir, args.full)
        write_jsonl(raw_dir / f"{name}.jsonl", rows)
        raw[name] = rows
        last = max((r["_rowid"] for r in rows), default=0)
        tables[name] = {"mode": info["mode"], "key": info.get("key", "_rowid"), "omit": info.get("omit", []), "rows": len(rows), "last_rowid": last, "server_rows": info["rows"], "server_last_rowid": info["last_rowid"], "pulled": how}
        log(f"  {name}: {len(rows)} 列（{how}）")
    # 舊的 raw 檔如果已經不在匯出清單（例如表被拿掉），留著但不列進 manifest

    n_runs = expand_ai_runs(out, raw)
    n_px = expand_prices(out, raw)
    manifest = {
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "server_time": meta.get("generated_at"),
        "worker_url": base,
        "worker_version": meta.get("version"),
        "launch_date": meta.get("launch_date"),
        "full": bool(args.full),
        "not_exported": meta.get("not_exported", []),
        "expanded": {"ai_runs": n_runs, "prices": n_px},
        "tables": tables,
    }
    write_json(mpath, manifest)
    log(f"完成：{len(tables)} 張表、{n_runs} 次 AI 分析、{n_px} 檔價格；manifest.json 已更新")


if __name__ == "__main__":
    main()
