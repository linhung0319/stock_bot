"""資料源驗證的共用工具（不是產品程式碼）。

用途：
  - 讀 API key／User-Agent（專案 .env 的 SEC_EDGAR_USER_AGENT；TradingAgents/.env 的
    FRED_API_KEY、ALPHA_VANTAGE_API_KEY）。只放在記憶體，不印出、不寫進檔名或快取。
  - get()：帶本機快取的 HTTP GET。快取鍵是「去掉 api_key／apikey 參數後的網址」的 SHA-1，
    所以快取檔名與內容都不含 key。同一網址第二次呼叫直接讀快取，不重抓。
  - SEC 請求自動加 User-Agent，並限速每秒 ≤ 5 次。

用法：其他腳本 `from common import get, sec_get, env` 即可；本檔不單獨執行。
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
CACHE = RAW / "http_cache"
CACHE.mkdir(parents=True, exist_ok=True)
PROJECT = HERE.parents[1]
TA_ENV = PROJECT.parent / "TradingAgents" / ".env"
LEAN = PROJECT.parent / "Stock" / "lean_strategies" / "data-sp500-long"

_SECRET_PARAMS = {"api_key", "apikey", "token"}


def _read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def env(name: str) -> str:
    for path in (PROJECT / ".env", TA_ENV):
        val = _read_env(path).get(name)
        if val:
            return val
    raise SystemExit(f"找不到環境變數 {name}")


def _scrub(url: str) -> str:
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query) if k.lower() not in _SECRET_PARAMS]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), ""))


def cache_path(url: str, suffix: str = "") -> Path:
    key = hashlib.sha1(_scrub(url).encode()).hexdigest()[:20]
    return CACHE / f"{key}{suffix}"


_last_sec = [0.0]


def get(url: str, headers: dict | None = None, *, refresh: bool = False, min_interval: float = 0.0,
        binary: bool = False, timeout: float = 60, allow_status=(200,)) -> tuple[int, bytes | str, dict]:
    """回傳 (status, body, meta)。meta 含 fetched_at 與 response headers 的一部分。"""
    body_p = cache_path(url, ".body")
    meta_p = cache_path(url, ".meta.json")
    if body_p.exists() and meta_p.exists() and not refresh:
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        data = body_p.read_bytes()
        return meta["status"], (data if binary else data.decode("utf-8", "replace")), meta
    if min_interval:
        wait = _last_sec[0] + min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
    r = requests.get(url, headers=headers or {}, timeout=timeout)
    _last_sec[0] = time.time()
    meta = {"status": r.status_code, "url": _scrub(url), "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "headers": {k: v for k, v in r.headers.items()
                        if k.lower() in ("content-type", "last-modified", "date", "etag")}}
    if r.status_code in allow_status:
        body_p.write_bytes(r.content)
        meta_p.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return r.status_code, (r.content if binary else r.text), meta


def sec_get(url: str, **kw):
    ua = env("SEC_EDGAR_USER_AGENT")
    return get(url, headers={"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}, min_interval=0.25, **kw)


def sec_json(url: str, **kw):
    status, body, meta = sec_get(url, **kw)
    if status != 200:
        return None
    return json.loads(body)


def cik10(cik) -> str:
    return f"{int(cik):010d}"


def redact(text: str) -> str:
    """防止 key 出現在輸出：把 apikey=xxx 換掉。"""
    return re.sub(r"(api_?key=)[^&\s]+", r"\1***", text, flags=re.I)
