"""B-9：抓 SEC 申報原文（只抓需要的部分），快取在 backtest/data/b9_docs/（已在 .gitignore）。

- User-Agent 從專案 .env 的 SEC_EDGAR_USER_AGENT 讀（research/data_sources/common.py 的 env()），不印出。
- 限速：每秒 ≤ 4 次。
- head_bytes：只讀檔案開頭的 N 位元組（串流讀取後中斷），424B／委託書封面用；8-K 4.01 讀全文。
- 同一網址只抓一次：快取檔名是網址的 SHA-1。

本檔是函式庫，由 b9_events.py 呼叫；也可以單獨執行 `uv run python backtest/b9_fetch.py <url>` 測試。
"""
from __future__ import annotations

import hashlib
import html
import re
import sys
import time
from pathlib import Path

import threading

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "research" / "data_sources"))
from common import env  # noqa: E402

DOCS = HERE / "data" / "b9_docs"
DOCS.mkdir(parents=True, exist_ok=True)
_last = [0.0]
_lock = threading.Lock()
_session = requests.Session()
STATS = {"net": 0, "cache": 0, "fail": 0}


def doc_url(cik, accn: str, primary: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accn.replace('-', '')}/{primary}"


def header_url(cik, accn: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accn.replace('-', '')}/{accn}-index-headers.html"


def fetch(url: str, head_bytes: int | None = None) -> str | None:
    key = hashlib.sha1(f"{url}|{head_bytes}".encode()).hexdigest()[:24]
    p = DOCS / f"{key}.txt"
    miss = DOCS / f"{key}.miss"
    if p.exists():
        STATS["cache"] += 1
        return p.read_text(encoding="utf-8", errors="replace")
    if miss.exists():
        return None
    headers = {"User-Agent": env("SEC_EDGAR_USER_AGENT"), "Accept-Encoding": "gzip, deflate"}
    for attempt in range(3):
        with _lock:  # 全域限速：兩次請求開始時間至少相隔 0.25 秒（≤ 4 次／秒）
            wait = _last[0] + 0.25 - time.time()
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        try:
            r = requests.get(url, headers=headers, timeout=60, stream=True)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code != 200:
                miss.write_text(f"{r.status_code} {url}")
                STATS["fail"] += 1
                return None
            buf = b""
            for chunk in r.iter_content(16384):
                buf += chunk
                if head_bytes and len(buf) >= head_bytes:
                    break
            r.close()
            try:
                text = buf.decode("utf-8")
            except UnicodeDecodeError:
                text = buf.decode("cp1252", errors="replace")
            p.write_text(text, encoding="utf-8")
            STATS["net"] += 1
            return text
        except requests.RequestException:
            time.sleep(5 * (attempt + 1))
    STATS["fail"] += 1
    return None


_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    t = _TAG.sub(" ", raw)
    t = html.unescape(t).replace("\xa0", " ")
    return _WS.sub(" ", t).strip()


if __name__ == "__main__":
    t = fetch(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else None)
    print(to_text(t or "")[:3000])
