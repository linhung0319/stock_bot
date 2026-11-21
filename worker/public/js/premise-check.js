// 持股頁「前提最近一次的結果」不碰 DOM 的部分（T61，composite_layer_design §2.1）。
// 四種寫法由伺服器照歷次定期審查算好（src/app/site/thesisView.ts 的 premiseCheckOf：kind／text／why），
// 這裡只決定顏色、示範模式怎麼補、史萊姆那一句怎麼數。測試直接 import 這一份。

/** 四種寫法各用哪個顏色（app.css 的 .st.*）：證實綠、被判不成立紅、沒驗到（這次／已經 N 次）黃。 */
export const CHECK_TONE = { CONFIRMED: 'HOLDS', BROKEN: 'BROKEN', MISSED: 'INSUFFICIENT', MISSED_MANY: 'INSUFFICIENT' };

const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const DEMO = { HOLDS: ['CONFIRMED', '證實'], BROKEN: ['BROKEN', '被判不成立'] };

/**
 * 每條前提最近一次的結果（編號 → { kind, text, why }）。
 * 示範模式的論點檔沒有審查紀錄（partial），但持股頁下面有示範的 AI 審查（d.ai）：
 * 從那次審查的前提結果補上，史萊姆才不會說「還沒有被 AI 審查過」（T39a）。信念不補（不進審查）。
 */
export function premiseChecks(d) {
  const checks = { ...(d.thesis?.premiseChecks ?? {}) };
  const ai = d.ai?.premises ?? [];
  for (const p of d.own?.premises ?? []) {
    if (checks[p.id]?.kind || p.belief) continue;
    const a = ai.find((x) => x.text && (x.text === p.text || p.text.startsWith(x.text) || x.text.startsWith(p.text)));
    if (!a || !d.ai?.date) continue;
    if (DEMO[a.status]) checks[p.id] = { kind: DEMO[a.status][0], text: `${md(d.ai.date)} ${DEMO[a.status][1]}`, why: null };
    else if (a.status === 'INSUFFICIENT') checks[p.id] = { kind: 'MISSED', text: '這次沒驗到（還沒有證實過）', why: `${md(d.ai.date)} 審查：證據不足` };
  }
  return checks;
}

/**
 * 史萊姆那一句用的數法：
 *   broken  最近一次審查被判不成立的前提（編號）
 *   judged  進審查的前提有幾條（信念不算）
 *   text    「你的 5 條前提：3 條證實、1 條這次沒驗到、1 條還沒檢查」；全部是信念時是 null
 * 「沒驗到」是證據不足或三票不一致，不是不成立，所以和「被判不成立」分開數。
 */
export function premiseSummary(premises, checks) {
  const judged = premises.filter((p) => !p.belief);
  const kindOf = (p) => checks[p.id]?.kind ?? null;
  const broken = judged.filter((p) => kindOf(p) === 'BROKEN').map((p) => p.id);
  const n = judged.length;
  if (!n) return { broken, judged: 0, text: null };
  const cnt = (...kinds) => judged.filter((p) => kinds.includes(kindOf(p))).length;
  const [ok, missed, none] = [cnt('CONFIRMED'), cnt('MISSED', 'MISSED_MANY'), cnt(null)];
  const text =
    none === n
      ? `你的 ${n} 條前提還沒有被 AI 審查過`
      : ok === n
        ? `你的 ${n} 條前提最近一次審查都證實`
        : `你的 ${n} 條前提：${[ok ? `${ok} 條證實` : '', missed ? `${missed} 條這次沒驗到` : '', broken.length ? `${broken.length} 條被判不成立` : '', none ? `${none} 條還沒檢查` : ''].filter(Boolean).join('、')}`;
  return { broken, judged: n, text };
}
