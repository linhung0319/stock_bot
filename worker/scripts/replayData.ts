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

/** 新規則的基準（階段十二 T80）匯出了沒：cash.f64 與 expected_b12_<年>.json（export_replay_data.py --b12）。 */
export function b12Available(): boolean {
  return fixturesAvailable() && existsSync(join(FIXTURE_DIR, 'cash.f64')) && existsSync(join(FIXTURE_DIR, 'expected_b12_2000.json')) && existsSync(join(FIXTURE_DIR, 'expected_b12_2013.json'));
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
  // 現金（SGOV／國庫券）的累積報酬指數：只有新規則的基準用（replay 的 core: 'ratio'）
  const cash = existsSync(join(FIXTURE_DIR, 'cash.f64')) ? matrix('cash.f64', ['CASH'], n).CASH : undefined;
  return {
    data: {
      days: meta.days,
      close: matrix('close.f64', meta.tickers, n),
      open: matrix('open.f64', meta.tickers, n),
      ranks: JSON.parse(readFileSync(join(FIXTURE_DIR, 'ranks.json'), 'utf8')),
      ...(cash ? { cash } : {}),
    },
    runs: meta.runs,
    fee: meta.fee,
    volWindow: meta.vol_window,
  };
}

export function loadExpected(tag: string): Expected {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `expected_${tag}.json`), 'utf8'));
}
/** 新規則的基準：回測 b10_account.simulate「M2 只有波動度＋SGOV 20%、有慢規則、偏移 0」的每日淨值與下單紀錄。 */
export function loadExpectedB12(tag: string): Expected {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `expected_b12_${tag}.json`), 'utf8'));
}
/** Expected 的下單紀錄換成重放的格式。 */
export function expectedOrders(exp: Expected): ReplayOrder[] {
  return exp.orders.map((o) => ({ date: o.date, nOrders: o.n_orders, reasons: o.reasons, ratioOnly: o.ratio_only, orders: o.orders }));
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

/**
 * 讀 B12_account.csv 裡某一期間「M2 只有波動度＋SGOV 20%、有慢規則、出場名次 15、偏移 0」那一列的年化、Sharpe、最大回撤
 * （新規則的重放基準，allocation_redesign §1.6）。CSV 的期間欄有逗號以外的全形字，沒有內嵌逗號，直接用逗號切。
 */
export function loadB12Stats(tag: string): { cagr: number; sharpe: number; maxDrawdown: number } {
  const text = stripBom(readFileSync(join(RESULTS_DIR, 'B12_account.csv'), 'utf8'));
  const rows = text.split(/\r?\n/).filter(Boolean);
  const head = rows[0].split(',');
  const col = (name: string) => head.indexOf(name);
  for (const line of rows.slice(1)) {
    const p = line.split(',');
    if (p[0].startsWith(tag) && p[col('動能')] === 'M2 只有波動度' && p[col('核心')] === 'SGOV 20%' && p[col('自選')] === '有慢規則' && p[col('出場名次')] === '15' && p[col('偏移')] === '0') {
      return { cagr: Number(p[col('年化')]), sharpe: Number(p[col('Sharpe')]), maxDrawdown: Number(p[col('最大回撤')]) };
    }
  }
  throw new Error(`B12_account.csv 找不到 ${tag} M2＋SGOV 20%`);
}

/** 回測「緩衝 0.10」情境用的設定：比例 20/30/50、跨桶上限、搭便車、5% 門檻；核心用 SPY 代理。 */
export const BACKTEST_CONFIG: EngineConfig = {
  ...DEFAULT_CONFIG,
  coreTicker: 'SPY',
  momBase: 'system',
  volHystCapFirst: true,
  crossTrimAlways: false,
};
