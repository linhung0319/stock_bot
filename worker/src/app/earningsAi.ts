// T29c：財報新聞稿當天確認財報類條件（own_thesis §1.11，功能 OWN_EARNINGS）。
//   開（startOwnEarnings，每日第一次流程開新執行的那一段）：自選股當天有新的 8-K Item 2.02、同一批新申報裡沒有 10-Q／10-K，
//       而且這檔有至少一條你定的（ACTIVE）財報類條件、指標在可算的範圍內（CfoToNetIncome 不算）→ 三票只抄數字
//   套用（applyOwnEarnings）：§1.11 的六項程式檢查（src/ai/earnings.ts）都過 → 程式算這一季的指標，和條件的門檻比：
//       你定的條件成立 → MET、met_basis = PRESS → 甲類通知（理由寫「依財報新聞稿…10-Q 出來後再核對」）；
//       你定的與觀察項都寫進度 progress_json（basis = PRESS，§3.6.2）；觀察項成立也不通知
//     不過或沒擷取到 → 什麼都不做（只記錄）；10-Q／10-K 出來時照原本的方式比對
//   10-Q／10-K 出來後的核對在 src/app/ownAi.ts 的 ownXbrlConditions（pressVerify）。
import type { PackDoc } from '../ai/check';
import { OWN_EARNINGS, earningsDecision, earningsPack, pressCheckable, pressRow, type EarningsDetail } from '../ai/earnings';
import { newRunId } from '../ai/pack';
import { XBRL_METRICS, fetchCompanyFacts, fetchPressRelease, quarterTable, xbrlConditionMet } from '../data/edgar';
import { errText } from '../data/util';
import { ownHeld } from '../engine';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import { docOf, metStmt, notifyOwnCondition, xbrlDoc } from './ownAi';
import { fileConditions, fmtMetric, isOwned, xbrlProgress, type FileCondition } from './thesis';

/** 會用新聞稿判斷的你定的條件：監測中、財報類、指標在可算的範圍內。 */
const eligible = (c: FileCondition) => c.status === 'ACTIVE' && isOwned(c) && pressCheckable(c);

/** 新的申報裡最新的一份 8-K Item 2.02（財報新聞稿）。 */
const latestPress = <F extends { form: string; items: string[]; acceptedAt: string }>(fs: F[]) =>
  fs.filter((f) => f.form.startsWith('8-K') && f.items.includes('2.02')).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))[0];

/**
 * 開 OWN_EARNINGS（own_thesis §1.11「什麼時候開」）。證據包：8-K 的本文、EX-99.1（pressExcerpt 取過）、XBRL 八季表（對照用）；
 * XBRL 表的完整數字放在 rule.detail.xbrl，套用時的程式檢查用。找不到 EX-99.1、XBRL 抓不到 → 不開，只記錄（條件照舊等 10-Q／10-K）。
 */
export async function startOwnEarnings(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, session, now, res } = sc;
  const ua = env.EDGAR_USER_AGENT ?? '';
  for (const c of sc.checks) {
    if (!acct.own[c.ticker] || !ownHeld(acct, c.ticker)) continue; // 0 股的自選不送條件監測（T39b）
    const pr = latestPress(c.fresh);
    if (!pr) continue;
    const conds = (await fileConditions(env.DB, acct, c.ticker)).filter((x) => x.kind === 'XBRL' && x.status === 'ACTIVE' && isOwned(x));
    if (!conds.length) continue;
    if (c.fresh.some((f) => /^10-[QK]/.test(f.form))) {
      res.log.push(`${c.ticker} 的財報新聞稿和 10-Q／10-K 同一批出來：財報條件由程式直接比對 XBRL，不擷取新聞稿`);
      continue;
    }
    const usable = conds.filter(eligible);
    if (!usable.length) {
      res.log.push(`${c.ticker} 有財報新聞稿，但你定的財報條件（${conds.map((x) => XBRL_METRICS[String(x.check.metric)]?.label ?? String(x.check.metric)).join('、')}）新聞稿算不出來，等 10-Q／10-K`);
      continue;
    }
    try {
      const rows = quarterTable(await fetchCompanyFacts(fetcher, c.cik, ua), session);
      const xdoc = xbrlDoc(c.ticker, rows);
      if (!xdoc) throw new Error('XBRL 沒有季度數字');
      const rel = await fetchPressRelease(fetcher, c.cik, pr, ua);
      if (!rel.exhibit) {
        res.log.push(`${c.ticker} 的 8-K ${pr.filingDate}（${pr.accession}）找不到財報新聞稿（EX-99.1），不擷取；財報條件等 10-Q／10-K`);
        continue;
      }
      const body = docOf(rel.body);
      const exhibit: PackDoc = { id: `P-${pr.accession}`, source_id: `edgar:${pr.accession}:EX-99.1`, kind: 'filing', date: pr.filingDate, title: `8-K ${pr.filingDate} 的財報新聞稿（EX-99.1）`, url: rel.exhibit.url, text: rel.exhibit.text, fetched_at: now.toISOString() };
      const detail: EarningsDetail = { accession: pr.accession, filingDate: pr.filingDate, conds: usable.map((x) => x.id), xbrl: rows };
      const { pack, notes } = earningsPack({ ticker: c.ticker, runId: newRunId(session, OWN_EARNINGS, c.ticker), asOf: session, body, exhibit, xbrlDoc: xdoc, detail, now });
      res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
      res.log.push(`${c.ticker} 的財報新聞稿（8-K ${pr.filingDate}）：開財報數字擷取，確認 ${usable.length} 條你定的財報條件`);
    } catch (e) {
      res.log.push(`${c.ticker} 的財報數字擷取沒有開成（財報條件等 10-Q／10-K）：${errText(e)}`);
    }
  }
}

/** 財報新聞稿成立的理由（met_basis = PRESS）：`最新一季毛利率 68.4%（依財報新聞稿 8-K 2027-01-06；10-Q 出來後再核對）`。 */
export function pressWhy(check: Record<string, unknown>, values: (number | null)[], filingDate: string): string {
  const metric = String(check.metric);
  const label = XBRL_METRICS[metric]?.label ?? metric;
  const vs = values.map((v) => fmtMetric(metric, v));
  const src = `依財報新聞稿 8-K ${filingDate}；10-Q 出來後再核對`;
  return vs.length > 1 ? `最近 ${vs.length} 季${label} ${vs.join('、')}（新到舊；最新一季${src}，之前的季取自 XBRL）` : `最新一季${label} ${vs[0]}（${src}）`;
}

/** OWN_EARNINGS → 程式檢查、算指標、和你定的財報條件比（own_thesis §1.11）。 */
export async function applyOwnEarnings(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const detail = (run.pack.rule.detail ?? {}) as Partial<EarningsDetail>;
  const rows = detail.xbrl ?? [];
  const d = earningsDecision(run.outcome, run.pack, rows);
  if (!d.ok) return void ctx.log.push(`${run.runId}：財報新聞稿的數字不採用${d.check ? `（檢查 ${d.check} 不過）` : ''}：${d.why}；財報條件照舊等 10-Q／10-K`);
  ctx.log.push(`${run.runId}：${d.why}`);
  const all = [pressRow(d.period, d.figures, rows, { filingDate: detail.filingDate ?? run.asOf, accession: detail.accession ?? '' }), ...rows];
  const at = ctx.now.toISOString();
  for (const c of (await fileConditions(ctx.db, ctx.acct, t)).filter((x) => pressCheckable(x) && (x.status === 'ACTIVE' || x.status === 'PROPOSED'))) {
    const check = c.check as { type: string; metric: string; level: number; quarters?: number };
    // 第 6 項：要連續幾季的，本季用擷取的、更早的季用 XBRL；算不出來（指標的項目沒採用、XBRL 少一季）就不判斷
    const m = xbrlConditionMet(all, check);
    if (!m) {
      ctx.log.push(`${t} 財報條件 ${c.condId}：新聞稿的數字算不出${XBRL_METRICS[check.metric]?.label ?? check.metric}，等 10-Q／10-K`);
      continue;
    }
    const p = xbrlProgress(all, check, ctx.session);
    if (p) ctx.stmts.push(ctx.db.prepare('UPDATE own_conditions SET progress_json = ? WHERE id = ?').bind(JSON.stringify({ ...p, basis: 'PRESS' }), c.id));
    if (!m.met) continue;
    if (c.status === 'PROPOSED') {
      ctx.log.push(`${t} 建議中的財報條件 ${c.condId} 依財報新聞稿成立；你還沒勾選，不通知（下一次審查會看到）`);
      continue;
    }
    ctx.stmts.push(metStmt(ctx.db, c.id, at, `財報新聞稿（8-K ${detail.filingDate ?? run.asOf}）：${m.values.map((v) => (v === null ? '—' : v.toFixed(4))).join('、')}`, 'PRESS'));
    (ctx.met ??= new Set()).add(c.id);
    notifyOwnCondition(ctx, c, pressWhy(check, m.values, detail.filingDate ?? run.asOf), [run.runId, c.runId], `${t} 財報條件 ${c.condId} 依財報新聞稿成立`);
  }
}
