// T68：網頁來源的 AI 評級表（web_source_ratings；confirm_audit_design_2026-11-21 §1.4、§1.5）。
//   查級別的順序在 src/data/webSources.ts 的 rateDomain（排除 → 種子 → 這張表 → UNRATED）；這裡只讀寫表。
//   寫入只經過 POST /ai/task/<id>/ratings（src/app/webEvidence.ts 的 handleTaskRatings）；不會自動重評，種子改了以種子為準。
import type { AiTier, WebRatingRow } from '../data/webSources';

/** 整張評級表（網域 → 列）。表很小（每個 AI 評過的網域一列），每次要用時整張讀。表還沒建（migration 沒套）時當成空的。 */
export async function loadRatings(db: D1Database): Promise<Map<string, WebRatingRow>> {
  try {
    const rows = (await db.prepare('SELECT domain, tier, site_name, reason, run_id, rated_at FROM web_source_ratings').all<WebRatingRow>()).results;
    return new Map(rows.map((r) => [r.domain, r]));
  } catch {
    return new Map();
  }
}

/** 寫一列（已經評過的不覆寫）：寫進去回 true，那個網域已經有一列回 false。 */
export async function insertRating(db: D1Database, r: { domain: string; tier: AiTier; siteName: string | null; reason: string; runId: string }, now: Date): Promise<boolean> {
  const res = await db
    .prepare('INSERT INTO web_source_ratings (domain, tier, site_name, reason, run_id, rated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (domain) DO NOTHING')
    .bind(r.domain, r.tier, r.siteName, r.reason, r.runId, now.toISOString())
    .run();
  return (res.meta.changes ?? 0) > 0;
}
