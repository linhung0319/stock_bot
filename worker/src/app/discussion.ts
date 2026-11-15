// T27：討論包要的資料（own_thesis §1.7）。讀 D1 與 EDGAR，所以不在 src/ai/discussion.ts（那裡是純函式）。
//   論點檔（thesisFile）、財報表（最近一次審查證據包裡的 XBRL 表；沒有就當場抓一次，抓不到寫「沒有財報表」）、
//   BREAK 情境的依據（通知 → 審查的執行 → 判不成立的前提與引用的原文）。
import { discussionNumbers, discussionPack, pickMode, type BreakInfo, type DiscussionMode } from '../ai/discussion';
import type { EvidencePack, Outcome } from '../ai/check';
import { fetchCompanyFacts, quarterTable, quarterTableText } from '../data/edgar';
import { errText } from '../data/util';
import type { Account, MarketView, Tier } from '../engine';
import { getRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { cikFor } from './filings';
import { metaFile, thesisFile, type ThesisFile } from './thesis';

/** 最近一次審查證據包裡的 XBRL 八季表（不用再抓）。 */
async function reviewXbrl(db: D1Database, ticker: string): Promise<string | null> {
  const r = await db.prepare("SELECT pack FROM ai_runs WHERE fn = 'OWN_REVIEW' AND ticker = ? ORDER BY created_at DESC LIMIT 1").bind(ticker).first<{ pack: string }>();
  if (!r) return null;
  try {
    return (JSON.parse(r.pack) as EvidencePack).documents.find((d) => d.kind === 'xbrl')?.text ?? null;
  } catch {
    return null;
  }
}

/** 財報表：先用最近一次審查的；沒有就當場抓一次 XBRL；抓不到是 null（討論包寫「沒有財報表」）。 */
export async function discussionXbrl(env: Env, fetcher: Fetcher, ticker: string, asOf: string): Promise<string | null> {
  const have = await reviewXbrl(env.DB, ticker);
  if (have) return have;
  try {
    const ua = env.EDGAR_USER_AGENT ?? '';
    const cik = ua ? await cikFor(env, fetcher, ticker) : null;
    if (!cik) return null;
    const rows = quarterTable(await fetchCompanyFacts(fetcher, cik, ua), asOf);
    return rows.length ? quarterTableText(ticker, rows) : null;
  } catch (e) {
    console.error('討論包的財報表抓不到', ticker, errText(e));
    return null;
  }
}

/**
 * BREAK 情境的依據（§1.7）：通知 #N 上這檔的 AI 項目 → 那次審查 → 三票都判不成立的前提（取編號最小的）與第一票引用的原文。
 * 找不到通知或執行時，用帳戶記的 aiTier（檔位、不成立的前提），原文寫「在網站」。
 */
export async function breakInfo(db: D1Database | null, acct: Account, file: ThesisFile, notif: number | null): Promise<BreakInfo> {
  const t = file.ticker;
  const meta = acct.own[t];
  const n = notif ? acct.notifs.find((x) => x.id === notif) : undefined;
  const item = n?.items.find((i) => i.ticker === t && i.choices.some((c) => c.id === 'AI'));
  const tier = (item?.choices.find((c) => c.id === 'AI')?.tier as Tier | undefined) ?? meta?.aiTier?.tier ?? null;
  const runId = item?.runIds?.[0] ?? meta?.aiTier?.runId ?? null;
  const review = runId ? file.reviews.find((r) => r.runId === runId) : undefined;
  const premiseId = review?.brokenPremises[0] ?? meta?.aiTier?.premiseId ?? null;
  const premiseText = premiseId ? (file.premises.find((p) => p.id === premiseId)?.text ?? null) : null;
  let quote: string | null = null;
  let source: string | null = null;
  if (db && runId && premiseId) {
    const run = await getRun(db, runId).catch(() => null);
    const o: Outcome | null = run?.outcome ?? null;
    for (const s of o?.samples.filter((x) => x.valid) ?? []) {
      const ids = s.premises.find((p) => p.premise_id === premiseId && p.status === 'BROKEN')?.evidence_ids ?? [];
      const ev = s.evidence.find((e) => e.ok && ids.includes(e.id) && !e.source_id.startsWith('nasdaq-rss:') && !e.source_id.startsWith('price:'));
      if (!ev) continue;
      quote = ev.quote;
      const doc = run!.pack.documents.find((d) => d.source_id === ev.source_id);
      source = doc ? `${doc.title}（${doc.date}）` : `${ev.source_id}（${ev.date}）`;
      break;
    }
  }
  return { notif: notif ?? null, premiseId, premiseText, tier, quote, source };
}

/** 真實模式的討論包：論點檔從 D1 組。 */
export async function realDiscussion(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, ticker: string, mode: DiscussionMode | null, notif: number | null): Promise<{ text: string; mode: DiscussionMode }> {
  const file = await thesisFile(env.DB, acct, ticker, view.date);
  if (!file) throw new Error(`${ticker} 不在自選裡`);
  const m = mode ?? pickMode(file, notif);
  const xbrl = await discussionXbrl(env, fetcher, ticker, view.date);
  const brk = m === 'BREAK' ? await breakInfo(env.DB, acct, file, notif) : null;
  return { text: discussionPack(file, discussionNumbers(acct, view, ticker, xbrl), m, brk), mode: m };
}

/** 示範模式的討論包：只用帳戶狀態（示範的帳戶不在 D1 的那幾張表裡），沒有財報表。 */
export async function demoDiscussion(acct: Account, view: MarketView, ticker: string, mode: DiscussionMode | null, notif: number | null): Promise<{ text: string; mode: DiscussionMode }> {
  const file = metaFile(acct, ticker, view.date);
  if (!file) throw new Error(`${ticker} 不在自選裡`);
  const m = mode ?? pickMode(file, notif);
  const brk = m === 'BREAK' ? await breakInfo(null, acct, file, notif) : null;
  return { text: discussionPack(file, discussionNumbers(acct, view, ticker, null), m, brk), mode: m };
}
