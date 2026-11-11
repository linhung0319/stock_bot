// 讀取 export_replay_data.py 匯出的固定檔（只在 Node 用）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type EngineConfig } from '../src/engine/types';
import type { ReplayData, ReplayOrder } from '../src/engine/replay';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '..', 'fixtures', 'replay');
export const RESULTS_DIR = join(HERE, '..', '..', 'backtest', 'results');

export interface ReplayRun {
  tag: string;
  own: string[];
  start: string;
  end: string;
}
export interface Expected {
  dates: string[];
  nav: number[];
  orders: { date: string; n_orders: number; reasons: string; ratio_only: boolean; orders: string }[];
  events: { date: string; ticker: string; action: string }[];
  stats: Record<string, number>;
  extra: Record<string, number>;
}
export type UniverseFile = Record<string, [string, number, number, number | null, number | null][]>;

export function fixturesAvailable(): boolean {
  return existsSync(join(FIXTURE_DIR, 'meta.json'));
}

function matrix(file: string, tickers: string[], nDays: number): Record<string, Float64Array> {
  const buf = readFileSync(join(FIXTURE_DIR, file));
  const all = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  if (all.length !== tickers.length * nDays) throw new Error(`${file} 大小不符`);
  const out: Record<string, Float64Array> = {};
  tickers.forEach((t, k) => {
    out[t] = all.slice(k * nDays, (k + 1) * nDays);
  });
  return out;
}

export function loadReplay(): { data: ReplayData; runs: ReplayRun[]; fee: number; volWindow: number } {
  const meta = JSON.parse(readFileSync(join(FIXTURE_DIR, 'meta.json'), 'utf8'));
  const n = meta.days.length;
  return {
    data: {
      days: meta.days,
      close: matrix('close.f64', meta.tickers, n),
      open: matrix('open.f64', meta.tickers, n),
      ranks: JSON.parse(readFileSync(join(FIXTURE_DIR, 'ranks.json'), 'utf8')),
    },
    runs: meta.runs,
    fee: meta.fee,
    volWindow: meta.vol_window,
  };
}

export function loadExpected(tag: string): Expected {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `expected_${tag}.json`), 'utf8'));
}
export function loadUniverse(): UniverseFile {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'universe.json'), 'utf8'));
}

const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** 讀 backtest/results/B8_orders_<年>.csv（回測凍結的輸出）。 */
export function loadB8Orders(tag: string): ReplayOrder[] {
  const text = stripBom(readFileSync(join(RESULTS_DIR, `B8_orders_${tag}.csv`), 'utf8'));
  const rows = text.split(/\r?\n/).filter(Boolean).slice(1);
  return rows.map((line) => {
    const p = line.split(',');
    return { date: p[0], nOrders: Number(p[1]), reasons: p[2], ratioOnly: p[3] === 'True', orders: p.slice(4).join(',') };
  });
}

/** 讀 B8_account.csv 裡某一期間、某一情境的年化、Sharpe、最大回撤。 */
export function loadB8Stats(tag: string, scenario: string): { cagr: number; sharpe: number; maxDrawdown: number } {
  const text = stripBom(readFileSync(join(RESULTS_DIR, 'B8_account.csv'), 'utf8'));
  const rows = text.split(/\r?\n/).filter(Boolean);
  const head = rows[0].split(',');
  const col = (name: string) => head.indexOf(name);
  for (const line of rows.slice(1)) {
    const p = line.split(',');
    if (p[0].startsWith(tag) && p[1] === scenario) {
      return { cagr: Number(p[col('年化')]), sharpe: Number(p[col('Sharpe')]), maxDrawdown: Number(p[col('最大回撤')]) };
    }
  }
  throw new Error(`B8_account.csv 找不到 ${tag} ${scenario}`);
}

/** 回測「緩衝 0.10」情境用的設定：比例 20/30/50、跨桶上限、搭便車、5% 門檻；核心用 SPY 代理。 */
export const BACKTEST_CONFIG: EngineConfig = {
  ...DEFAULT_CONFIG,
  coreTicker: 'SPY',
  momBase: 'system',
  volHystCapFirst: true,
  crossTrimAlways: false,
};
