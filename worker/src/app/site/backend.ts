// 網站讀寫資料的來源。兩種：
//   真實：帳本與價格都在 D1（T6 的資料層）。
//   示範：假市場＋腳本（src/demo），整個狀態存在 D1 的 demo_state 一列；和真實帳本完全分開。
// 網站的程式只認這個介面，所以兩種模式走同一套畫面與操作。
import type { Account, LedgerEvent, MarketView, ShadowRecord, Snapshot } from '../../engine';
import { lastCompletedSession } from '../../data/calendar';
import { BENCHMARK } from '../../data/ingest';
import { buildMarketView, rebaseNotifSeq } from '../../data/marketView';
import { fetchYahooDaily, type Fetcher } from '../../data/sources';
import { loadCalendarOverrides, loadRanking, loadSeries, saveSeries, seriesFromBars } from '../../data/store';
import { errText, retry } from '../../data/util';
import { DEMO_IDS, DEMO_SCRIPTS, type DemoId } from '../../demo/demoScripts';
import { advanceDemo, demoAtEnd, demoFill, demoFilledSnapshot, demoMarket, demoView, resetDemo, type AdvanceMode, type DemoState, type OnNotifs } from '../../demo/driver';
import { ranksAt } from '../../demo/market';
import type { Env } from '../env';
import { ConflictError, loadAccount, loadEvents, loadShadow, requiredTickers, saveAccount, saveSnapshot, type LoadedAccount } from '../ledgerStore';
import { annotate } from './explain';
import type { AiNote } from './types';

export interface DemoInfo {
  scenario: DemoId;
  title: string;
  summary: string;
  tips: string[];
  atEnd: boolean;
  scenarios: { id: DemoId; title: string }[];
}

export interface SiteData {
  mode: 'real' | 'demo';
  acct: Account | null;
  /** 最近一個收盤日的市場；沒有價格資料時是 null。 */
  view: MarketView | null;
  /** 交易日（由舊到新，最後一個是 view.date）。 */
  axis: string[];
  rankOrder: string[];
  rankSession: string | null;
  aiNotes: AiNote[];
  /** 之前存下來的帳本事件與「沒照做」紀錄（這次請求新增的在 acct 裡）。 */
  events: LedgerEvent[];
  shadow: ShadowRecord[];
  /** 估成交金額用的價格；沒有就用收盤。 */
  fill?: (ticker: string) => number;
  /** 使用者操作的這一天。 */
  today: string;
  warnings: string[];
  demo?: DemoInfo;
  /** 示範：照清單以開盤價成交後的數字（幫使用者填快照用）。 */
  autofill?: (extra?: Record<string, number>, exact?: boolean) => Snapshot;
}

export interface SiteBackend {
  mode: 'real' | 'demo';
  /** extra：這次操作另外需要價格的代號（真實模式沒有存的會當場去抓）。 */
  load(extra?: string[]): Promise<SiteData>;
  save(acct: Account, cause: string): Promise<void>;
  recordSnapshot(date: string, snap: Snapshot): Promise<void>;
}

const taipeiDate = (now: Date): string => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- 真實

export function realBackend(env: Env, fetcher: Fetcher, now: Date): SiteBackend {
  let loaded: LoadedAccount | null = null;
  let rev: number | null = null;
  return {
    mode: 'real',
    async load(extra = []) {
      loaded = await loadAccount(env.DB);
      const acct = loaded?.acct ?? null;
      const warnings: string[] = [];
      const ranking = await loadRanking(env.DB);
      const core = acct?.cfg.coreTicker ?? 'VOO';
      const required = requiredTickers(acct);
      const want = [...new Set([...required, BENCHMARK, ...(ranking?.order ?? []), ...extra])];
      let series = await loadSeries(env.DB, want);
      const session = series.get(core)?.d.at(-1) ?? null;
      // 這次操作要用、但沒有存或不是最新的代號：當場抓一次（新增自選、快照出現新代號、建立帳戶）
      const missing = session ? extra.filter((t) => series.get(t)?.d.at(-1) !== session) : [];
      if (missing.length && session) {
        const got = await Promise.all(
          missing.map(async (t) => {
            try {
              const s = await retry(() => fetchYahooDaily(fetcher, t, '2y'));
              return seriesFromBars(t, s.bars.filter((b) => b.date <= session), now.toISOString(), session);
            } catch (e) {
              warnings.push(`抓不到 ${t} 的價格（${errText(e)}）`);
              return null;
            }
          }),
        );
        const ok = got.filter((s): s is NonNullable<typeof s> => !!s && s.d.length > 0);
        if (ok.length) {
          await saveSeries(env.DB, ok);
          series = await loadSeries(env.DB, want);
        }
      }
      let view: MarketView | null = null;
      let axis: string[] = [];
      if (session) {
        const built = buildMarketView(series, session, core);
        view = built.view;
        axis = built.axis;
        const stale = built.stale.filter((t) => required.includes(t) || extra.includes(t));
        if (stale.length) warnings.push(`這些代號沒有 ${session} 的收盤價：${stale.join('、')}。用到它們的清單暫時算不出來。`);
        const expect = lastCompletedSession(now, await loadCalendarOverrides(env.DB));
        if (session < expect) warnings.push(`價格只更新到 ${session}（應該要有 ${expect}）。每日抓取可能失敗了；清單是用 ${session} 的收盤算的。`);
        if (acct) rebaseNotifSeq(acct, axis);
      } else {
        warnings.push('還沒有價格資料：每日抓取還沒有跑過。');
      }
      // 最近 36 小時的告警（每日流程、資料抓取）也放在網站的警示列；已經解決的不放
      const since = new Date(now.getTime() - 36 * 3600_000).toISOString();
      const alerts = (await env.DB.prepare("SELECT message, MAX(id) AS id FROM alerts WHERE at >= ? AND (sent_at IS NULL OR sent_at NOT IN ('RESOLVED', 'SKIPPED_OLD')) GROUP BY message ORDER BY id DESC LIMIT 5").bind(since).all<{ message: string }>()).results;
      for (const a of alerts) warnings.push(a.message);
      const [events, shadow] = acct ? await Promise.all([loadEvents(env.DB, 300), loadShadow(env.DB, 300)]) : [[], []];
      return { mode: 'real', acct, view, axis, rankOrder: ranking?.order ?? [], rankSession: ranking?.session ?? null, aiNotes: [], events, shadow, today: taipeiDate(now), warnings };
    },
    async save(acct, cause) {
      rev = await saveAccount(env.DB, acct, loaded, cause, now);
    },
    async recordSnapshot(date, snap) {
      await saveSnapshot(env.DB, date, snap, now, rev);
    },
  };
}

// ---------------------------------------------------------------- 示範

interface DemoRow {
  rev: number;
  scenario: string;
  d: number;
  body: string;
}

export interface DemoBackend extends SiteBackend {
  reset(id: DemoId): Promise<void>;
  advance(mode: AdvanceMode): Promise<{ days: number; created: number[] }>;
}

export function demoBackend(env: Env, now: Date): DemoBackend {
  let st: DemoState | null = null;
  let rev = 0;
  const onNotifs: OnNotifs = (acct, view, rankOrder) => {
    const m = demoMarket(st?.scenario ?? 's1');
    annotate({ acct, view, axis: m.days.slice(0, view.i + 1), rankOrder, aiNotes: DEMO_SCRIPTS[st?.scenario ?? 's1'].notes });
  };
  const read = async () => {
    const row = await env.DB.prepare('SELECT rev, scenario, d, body FROM demo_state WHERE id = 1').first<DemoRow>();
    if (!row) {
      st = null;
      rev = 0;
      return;
    }
    st = { scenario: row.scenario as DemoId, d: row.d, acct: JSON.parse(row.body) as Account };
    rev = row.rev;
  };
  const write = async (next: DemoState) => {
    const body = JSON.stringify(next.acct);
    const at = now.toISOString();
    if (rev === 0) {
      await env.DB.prepare('INSERT INTO demo_state (id, rev, scenario, d, updated_at, body) VALUES (1, 1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rev = demo_state.rev + 1, scenario = excluded.scenario, d = excluded.d, updated_at = excluded.updated_at, body = excluded.body')
        .bind(next.scenario, next.d, at, body)
        .run();
    } else {
      const r = await env.DB.prepare('UPDATE demo_state SET rev = rev + 1, scenario = ?, d = ?, updated_at = ?, body = ? WHERE id = 1 AND rev = ?').bind(next.scenario, next.d, at, body, rev).run();
      if (!r.meta.changes) throw new ConflictError('示範資料已經被另一個操作更新，請重新整理再做一次');
    }
    st = next;
    rev += 1;
  };
  const info = (s: DemoState): DemoInfo => {
    const sc = DEMO_SCRIPTS[s.scenario];
    return { scenario: s.scenario, title: sc.title, summary: sc.summary, tips: sc.tips, atEnd: demoAtEnd(s), scenarios: DEMO_IDS.map((id) => ({ id, title: DEMO_SCRIPTS[id].title })) };
  };
  return {
    mode: 'demo',
    async load() {
      await read();
      if (!st) {
        // 第一次進示範模式：從情境 ① 開始
        st = { scenario: 's1', d: 0, acct: null as unknown as Account };
        await write(resetDemo('s1', onNotifs));
      }
      const s = st!;
      const m = demoMarket(s.scenario);
      const view = demoView(s);
      return {
        mode: 'demo',
        acct: s.acct,
        view,
        axis: m.days.slice(0, s.d),
        rankOrder: ranksAt(m, s.d - 1),
        rankSession: view.date,
        aiNotes: DEMO_SCRIPTS[s.scenario].notes,
        events: [],
        shadow: [],
        fill: demoFill(s),
        today: m.days[s.d],
        warnings: [],
        demo: info(s),
        autofill: (extra, exact) => demoFilledSnapshot({ ...s, acct: st!.acct }, extra, exact),
      };
    },
    async save(acct) {
      if (!st) throw new Error('示範資料還沒有載入');
      await write({ ...st, acct });
    },
    async recordSnapshot() {
      // 示範模式不另外留快照原文
    },
    async reset(id) {
      await read();
      st = st ?? { scenario: id, d: 0, acct: null as unknown as Account };
      st = { ...st, scenario: id };
      await write(resetDemo(id, onNotifs));
    },
    async advance(mode) {
      await read();
      if (!st) throw new Error('示範資料還沒有開始');
      const r = advanceDemo(st, mode, onNotifs);
      await write(r.state);
      return { days: r.days, created: r.created };
    },
  };
}

export { ConflictError };
