// T55：論點草稿（OWN_DRAFT，web_evidence_design §2.2、§2.4 第 6 點）。純函式：證據包、送回的草稿逐欄檢查、檢查過的草稿。
// 資料抓取、時機與上限、own_drafts 表在 src/app/ownDraft.ts。
//
//   權限 A2（只說明；使用者逐條勾選才有效果），一份（samples = 1），不是三票。
//   流程（own_draft_v1）：研究員讀證據包、可以找資料（和審查同一套取文件，§1.5）→ 反方先寫 → 正方回應 → 主筆寫草稿。
//   程式檢查（§2.2）不過的整份退回（這一票改成 INSUFFICIENT、原因寫進 issues），不給使用者半份草稿：
//     外殼與 evidence 照 check.ts（引用逐字出自證據包）；前提 3～5 條、出場條件 2～6 條、字數上限同 parseThesisBlock；
//     每條前提都有 breaks_if 與 checkable_by，NONE 最多 1 條；至少一條出清或減半的出場條件是財報數字門檻（數字有通過檢查的引用）；
//     反方 3 點、每點至少一條通過檢查的引用；來源的網域要是公開的 https 主機（safeWebUrl）；
//     這檔有還沒回覆的乙類通知時（§2.4 第 6 點）keep_id 不能是被判不成立的那一條，文字很像的標出來。
import type { CheckedEvidence, CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import { buildPack } from './pack';
import { premiseKey } from '../engine';
import type { CondAction } from '../app/thesis';
import { safeWebUrl } from '../data/webDoc';
import { WEB_EXCLUDED, hostMatches } from '../data/webSources';

export const OWN_DRAFT = 'OWN_DRAFT';
export const OWN_DRAFT_PROMPT = 'own_draft_v1';

/**
 * 程式檢查的數字（§2.2）。條數上限與字數上限同 parseThesisBlock 的 THESIS_LIMITS（src/ai/discussion.ts；這裡不 import 它，
 * 免得每個 AI 執行的檢查都拉進討論包的模組；測試確認兩邊一樣）。
 */
export const DRAFT_LIMITS = {
  premisesMin: 3,
  premisesMax: 5,
  exitsMin: 2,
  exitsMax: 6,
  thesis: 600,
  premise: 200,
  exit: 300,
  breaksIf: 300,
  hint: 200,
  against: 3,
  line: 300,
  noneMax: 1,
  notCheckable: 5,
  peers: 4,
  domains: 6,
} as const;

export const CHECKABLE_BY = ['XBRL', 'FILING', 'PEER_FILING', 'WEB', 'NONE'] as const;
export type CheckableBy = (typeof CHECKABLE_BY)[number];
const ACTIONS: readonly CondAction[] = ['EXIT', 'HALF', 'REVIEW'];
const XBRL_TYPES = ['xbrl_metric_below', 'xbrl_metric_above'];
const ANSWERS = ['YES', 'NO', 'UNSURE'] as const;

/** 開執行時這檔有還沒回覆的乙類通知（§2.4 第 6 點）：被判不成立的前提、它的文字、通知編號、草稿最上面固定的那句話。 */
export interface DraftBroken {
  premiseId: string;
  text: string;
  notif: number;
  notice: string;
}
/** 草稿最上面固定的那句話（§2.4 第 6 點；T56 顯示）。 */
export const brokenNotice = (premiseId: string): string => `前提 ${premiseId} 剛被判不成立。在這之後改論點，很容易只是替繼續持有找新理由`;

export interface DraftPremise {
  text: string;
  /** 沿用現行的哪一條（沒改字才能寫）；新的是 null。 */
  keep_id: string | null;
  breaks_if: string;
  checkable_by: CheckableBy;
  source_hint: string | null;
  /** 通過檢查的引用編號。 */
  evidence_ids: string[];
  /** 文字和剛被判不成立的那一條很像（§2.4 第 6 點：標出來，不擋）。 */
  like_broken?: boolean;
}
export interface DraftExit {
  text: string;
  action: CondAction;
  /** 對應第幾條前提（0 起）；沒有是 null。 */
  premise_index: number | null;
  evidence_ids: string[];
  kind: 'XBRL' | 'EVENT' | 'PRICE' | null;
  /** 財報門檻的格式（kind = XBRL）：{ type, metric, level, quarters? }；其他是 null。 */
  check: Record<string, unknown> | null;
  /** 這一條是程式比對得到的財報數字門檻（檢查過：指標程式算得出來、門檻有通過檢查的引用）。 */
  threshold: boolean;
}
/** 草稿提的網域：LISTED 已經在共用清單或這檔的來源裡／NEW 新的來源（存檔前會先試抓）／EXCLUDED 不列入的網站（加不進來）。 */
export interface DraftDomain {
  domain: string;
  state: 'LISTED' | 'NEW' | 'EXCLUDED';
  note: string;
}
export interface DraftPeer {
  name: string;
  edgar?: string;
  yahoo?: string;
}
/** 檢查過的草稿（own_drafts.payload）。 */
export interface OwnDraft {
  thesis: string;
  premises: DraftPremise[];
  exits: DraftExit[];
  sources: { peers: DraftPeer[]; domains: DraftDomain[] };
  against: { text: string; evidence_ids: string[] }[];
  would_buy_today: { answer: (typeof ANSWERS)[number]; why: string };
  not_checkable: string[];
  /** 通過檢查的引用（T56 的「引用（可展開）」用），帶來源的標題。 */
  evidence: (Pick<CheckedEvidence, 'id' | 'source_id' | 'date' | 'quote' | 'claim'> & { title: string | null; url: string | null })[];
  /** 主筆的報告（第一段是摘要）。 */
  report: string | null;
}

// ---------------------------------------------------------------- 證據包

export interface OwnDraftInput {
  runId: string;
  asOf: string;
  ticker: string;
  trigger: 'AUTO' | 'MANUAL';
  /** 已經持有（題目的寫法）。 */
  held: boolean;
  premises: PackPremise[];
  facts: EvidencePack['facts'];
  docs: PackDoc[];
  dataQuality: EvidencePack['data_quality'];
  thesisVersion: number;
  fileId: string | null;
  broken: DraftBroken | null;
  /** 可以當證據的網頁來源（共用清單＋這檔的一手網域；webEvidence.ts 的 sourceFacts）。記在 rule.detail.webDomains。 */
  webDomains: string[];
  now: Date;
}

export function ownDraftPack(inp: OwnDraftInput) {
  const who = inp.held ? `使用者持有自選股 ${inp.ticker}` : `使用者把 ${inp.ticker} 加進自選`;
  const brk = inp.broken;
  return buildPack({
    runId: inp.runId,
    fn: OWN_DRAFT,
    promptVersion: OWN_DRAFT_PROMPT,
    asOf: inp.asOf,
    subject: { ticker: inp.ticker },
    question:
      (brk ? `${brk.notice}。草稿不能沿用前提 ${brk.premiseId}（keep_id 不能寫 ${brk.premiseId}），也不要換個說法把它寫回來。` : '') +
      `${who}。請替使用者草擬這檔的論點（payload.thesis）、${DRAFT_LIMITS.premisesMin}～${DRAFT_LIMITS.premisesMax} 條前提（每條寫怎樣算不成立、查得到的來源）、` +
      `${DRAFT_LIMITS.exitsMin}～${DRAFT_LIMITS.exitsMax} 條出場條件（至少一條是出清或減半的財報數字門檻）。` +
      '反方先寫：這家公司最可能讓持有者後悔的三件事（各附證據），以及「如果現在沒有持股，今天用這個價格會不會買」的反方答案；正方要回應反方的三件事。' +
      '每一條前提都要查得到哪些證據顯示它成立、哪些顯示它不成立。這是草稿：每一條都要使用者勾選才會生效。不要評論該不該買或賣、不要寫股數或價位。',
    policy: { level: 'A2', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: {
      action: '只說明（草稿：使用者逐條勾選才生效）',
      detail: {
        trigger: inp.trigger,
        thesisVersion: inp.thesisVersion,
        fileId: inp.fileId,
        broken: brk,
        ...(inp.webDomains.length ? { webDomains: inp.webDomains } : {}),
      },
    },
    facts: inp.facts,
    premises: inp.premises,
    documents: inp.docs,
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

// ---------------------------------------------------------------- 程式檢查

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 字元雙字組（比文字像不像用）。 */
function bigrams(s: string): Set<string> {
  const k = premiseKey(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < k.length; i++) out.add(k.slice(i, i + 2));
  return out;
}
/** 文字像的門檻：雙字組的重疊（交集 ÷ 比較短的那一邊）。 */
export const LIKE_THRESHOLD = 0.6;
/** 兩段文字很像嗎（§2.4 第 6 點「文字很像的標出來」）：去掉空白與標點後一樣，或雙字組重疊 ≥ 0.6。 */
export function likeText(a: string, b: string): boolean {
  if (premiseKey(a) === premiseKey(b)) return true;
  const x = bigrams(a);
  const y = bigrams(b);
  const small = Math.min(x.size, y.size);
  if (small < 3) return false;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return common / small >= LIKE_THRESHOLD;
}

const EDGAR_CODE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const YAHOO_CODE = /^[A-Z0-9^][A-Z0-9.=^-]{0,19}$/;

/** 網域（或網址）→ 主機名稱；不是公開的 https 主機（safeWebUrl 不收）→ null。 */
function hostOf(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  const u = safeWebUrl(s);
  return u ? u.hostname.replace(/\.$/, '') : null;
}

interface PackDetail {
  broken?: DraftBroken | null;
  webDomains?: string[];
}

/**
 * 一票草稿的程式檢查（§2.2）。errors 有東西 = 不過（整份退回）；過了的回傳整理好的草稿。
 * 只認通過逐字檢查的引用；來源是 note（論點檔、上一份論點檔、買進時的一句話：使用者自己的話）的不算反方或門檻的依據。
 */
export function checkDraft(s: CheckedSample, pack: Pick<EvidencePack, 'documents' | 'premises' | 'rule'>, metrics: ReadonlySet<string>): { draft: OwnDraft | null; errors: string[] } {
  const errors: string[] = [];
  const p = s.payload ?? {};
  const detail = (pack.rule?.detail ?? {}) as PackDetail;
  const docs = new Map(pack.documents.map((d) => [d.source_id, d]));
  const okEv = s.evidence.filter((e) => e.ok);
  const okIds = new Set(okEv.map((e) => e.id));
  const goodIds = new Set(okEv.filter((e) => docs.get(e.source_id)?.kind !== 'note').map((e) => e.id));
  const L = DRAFT_LIMITS;

  // 論點
  const thesis = txt(p.thesis);
  if (!thesis) errors.push('沒有論點本文（thesis）');
  else if (thesis.length > L.thesis) errors.push(`論點超過 ${L.thesis} 字`);

  // 前提
  const brk = detail.broken ?? null;
  const current = new Map(pack.premises.filter((x) => x.origin !== 'SYSTEM_DEFAULT').map((x) => [x.id, x]));
  const rawPremises = Array.isArray(p.premises) ? p.premises : null;
  const premises: DraftPremise[] = [];
  if (!rawPremises) errors.push('premises 要是陣列');
  else if (rawPremises.length < L.premisesMin || rawPremises.length > L.premisesMax) errors.push(`前提要 ${L.premisesMin}～${L.premisesMax} 條（送回 ${rawPremises.length} 條）`);
  (rawPremises ?? []).slice(0, L.premisesMax + 1).forEach((raw, k) => {
    const n = `前提第 ${k + 1} 條`;
    if (!isObj(raw)) return void errors.push(`${n}格式不對`);
    const text = txt(raw.text);
    const breaks = txt(raw.breaks_if);
    const by = txt(raw.checkable_by).toUpperCase();
    const keep = raw.keep_id === null || raw.keep_id === undefined || raw.keep_id === '' ? null : txt(raw.keep_id).toUpperCase();
    if (!text) errors.push(`${n}沒有文字`);
    else if (text.length > L.premise) errors.push(`${n}超過 ${L.premise} 字`);
    if (!breaks) errors.push(`${n}沒有寫怎樣算不成立（breaks_if）`);
    else if (breaks.length > L.breaksIf) errors.push(`${n}的 breaks_if 超過 ${L.breaksIf} 字`);
    if (!(CHECKABLE_BY as readonly string[]).includes(by)) errors.push(`${n}的 checkable_by 要是 ${CHECKABLE_BY.join('、')} 其中之一`);
    const hint = txt(raw.source_hint);
    if (hint.length > L.hint) errors.push(`${n}的 source_hint 超過 ${L.hint} 字`);
    if (keep !== null) {
      if (brk && keep === brk.premiseId) errors.push(`${n}沿用了剛被判不成立的前提 ${brk.premiseId}（keep_id 不能是它）`);
      else {
        const cur = current.get(keep);
        if (!cur) errors.push(`${n}的 keep_id ${keep} 不是現行的前提`);
        else if (premiseKey(cur.text) !== premiseKey(text)) errors.push(`${n}沿用了 ${keep}，但字改了（沒改字才能寫 keep_id）`);
      }
    }
    premises.push({
      text,
      keep_id: keep,
      breaks_if: breaks,
      checkable_by: by as CheckableBy,
      source_hint: hint || null,
      evidence_ids: ids(raw.evidence_ids).filter((id) => okIds.has(id)),
      ...(brk && text && likeText(text, brk.text) ? { like_broken: true } : {}),
    });
  });
  const none = premises.filter((x) => x.checkable_by === 'NONE').length;
  if (none > L.noneMax) errors.push(`查不到的前提（checkable_by = NONE）最多 ${L.noneMax} 條（送回 ${none} 條）；寫不成查得到的事的放 not_checkable`);

  // 出場條件
  const rawExits = Array.isArray(p.exits) ? p.exits : null;
  const exits: DraftExit[] = [];
  if (!rawExits) errors.push('exits 要是陣列');
  else if (rawExits.length < L.exitsMin || rawExits.length > L.exitsMax) errors.push(`出場條件要 ${L.exitsMin}～${L.exitsMax} 條（送回 ${rawExits.length} 條）`);
  (rawExits ?? []).slice(0, L.exitsMax + 1).forEach((raw, k) => {
    const n = `出場條件第 ${k + 1} 條`;
    if (!isObj(raw)) return void errors.push(`${n}格式不對`);
    const text = txt(raw.text);
    const action = txt(raw.action).toUpperCase() as CondAction;
    if (!text) errors.push(`${n}沒有文字`);
    else if (text.length > L.exit) errors.push(`${n}超過 ${L.exit} 字`);
    if (!ACTIONS.includes(action)) errors.push(`${n}的 action 要是 EXIT、HALF 或 REVIEW`);
    const pi = raw.premise_index;
    const premiseIndex = typeof pi === 'number' && Number.isInteger(pi) && pi >= 0 && pi < premises.length ? pi : null;
    if (pi !== undefined && pi !== null && premiseIndex === null) errors.push(`${n}的 premise_index 對不到任何一條前提`);
    const kind = ['XBRL', 'EVENT', 'PRICE'].includes(txt(raw.kind).toUpperCase()) ? (txt(raw.kind).toUpperCase() as DraftExit['kind']) : null;
    const check = isObj(raw.check) ? raw.check : null;
    const ev = ids(raw.evidence_ids).filter((id) => okIds.has(id));
    // 財報數字門檻：指標程式算得出來、門檻是數字、季數合理、門檻有通過檢查的引用（check.ts 對數字門檻的同一條規則）
    const threshold =
      kind === 'XBRL' &&
      !!check &&
      XBRL_TYPES.includes(String(check.type)) &&
      metrics.has(String(check.metric)) &&
      typeof check.level === 'number' &&
      Number.isFinite(check.level) &&
      (check.quarters === undefined || (Number.isInteger(check.quarters) && Number(check.quarters) >= 1 && Number(check.quarters) <= 8)) &&
      ev.some((id) => goodIds.has(id));
    exits.push({ text, action, premise_index: premiseIndex, evidence_ids: ev, kind, check: kind === 'XBRL' && check ? check : null, threshold });
  });
  if (!exits.some((x) => (x.action === 'EXIT' || x.action === 'HALF') && x.threshold)) errors.push('至少要一條動作是出清或減半、而且是財報數字門檻的出場條件（kind XBRL、指標程式算得出來、門檻有通過檢查的引用）');

  // 反方
  const rawAgainst = Array.isArray(p.against) ? p.against : null;
  const against: OwnDraft['against'] = [];
  if (!rawAgainst || rawAgainst.length !== L.against) errors.push(`反方要 ${L.against} 點（送回 ${rawAgainst?.length ?? 0} 點）`);
  (rawAgainst ?? []).slice(0, L.against).forEach((raw, k) => {
    const n = `反方第 ${k + 1} 點`;
    const text = isObj(raw) ? txt(raw.text) : '';
    const ev = isObj(raw) ? ids(raw.evidence_ids) : [];
    if (!text) return void errors.push(`${n}沒有文字`);
    if (text.length > L.line) errors.push(`${n}超過 ${L.line} 字`);
    const good = ev.filter((id) => goodIds.has(id));
    if (!good.length) errors.push(`${n}沒有通過檢查的引用（論點檔與使用者自己寫的不算）`);
    against.push({ text, evidence_ids: good });
  });

  // 今天會不會買
  const wb = isObj(p.would_buy_today) ? p.would_buy_today : null;
  const answer = txt(wb?.answer).toUpperCase();
  const why = txt(wb?.why);
  if (!wb || !(ANSWERS as readonly string[]).includes(answer) || !why) errors.push('would_buy_today 要有 answer（YES、NO、UNSURE）與 why');
  else if (why.length > L.line) errors.push(`would_buy_today.why 超過 ${L.line} 字`);

  // 監測不了的觀察（只顯示）
  const nc = p.not_checkable === undefined || p.not_checkable === null ? [] : p.not_checkable;
  const notCheckable: string[] = [];
  if (!Array.isArray(nc) || nc.some((x) => typeof x !== 'string')) errors.push('not_checkable 要是字串陣列');
  else if (nc.length > L.notCheckable) errors.push(`not_checkable 最多 ${L.notCheckable} 項`);
  else
    for (const x of nc as string[]) {
      if (x.trim().length > L.line) errors.push(`not_checkable 有一項超過 ${L.line} 字`);
      else if (x.trim()) notCheckable.push(x.trim());
    }

  // 來源
  const src = isObj(p.sources) ? p.sources : {};
  const rawPeers = src.peers === undefined ? [] : src.peers;
  const rawDomains = src.domains === undefined ? [] : src.domains;
  const peers: DraftPeer[] = [];
  const domains: DraftDomain[] = [];
  if (!Array.isArray(rawPeers) || rawPeers.length > L.peers) errors.push(`sources.peers 要是陣列、最多 ${L.peers} 家`);
  else
    for (const raw of rawPeers) {
      const name = isObj(raw) ? txt(raw.name).slice(0, 60) : '';
      const edgar = isObj(raw) ? txt(raw.edgar).toUpperCase() : '';
      const yahoo = isObj(raw) ? txt(raw.yahoo).toUpperCase() : '';
      if (!name || (!edgar && !yahoo) || (edgar && !EDGAR_CODE.test(edgar)) || (yahoo && !YAHOO_CODE.test(yahoo))) {
        errors.push(`同業「${name || edgar || yahoo || '（空的）'}」要有名稱，與格式正確的 EDGAR 或 Yahoo 代號`);
        continue;
      }
      peers.push({ name, ...(edgar ? { edgar } : {}), ...(yahoo ? { yahoo } : {}) });
    }
  const listed = detail.webDomains ?? [];
  if (!Array.isArray(rawDomains) || rawDomains.length > L.domains) errors.push(`sources.domains 要是陣列、最多 ${L.domains} 個`);
  else
    for (const raw of rawDomains) {
      const host = typeof raw === 'string' ? hostOf(raw) : null;
      if (!host) {
        errors.push(`來源的網域「${typeof raw === 'string' ? raw.slice(0, 80) : '（不是字串）'}」不是公開的 https 網站`);
        continue;
      }
      if (domains.some((d) => d.domain === host)) continue;
      if (WEB_EXCLUDED.some((x) => hostMatches(host, x))) domains.push({ domain: host, state: 'EXCLUDED', note: '不列入的網站（評論、預測、社群）：加不進來' });
      else if (listed.some((x) => hostMatches(host, x))) domains.push({ domain: host, state: 'LISTED', note: '已經在清單裡' });
      else domains.push({ domain: host, state: 'NEW', note: '新的來源，存檔前會先試抓' });
    }

  if (errors.length) return { draft: null, errors };
  return {
    errors,
    draft: {
      thesis,
      premises,
      exits,
      sources: { peers, domains },
      against,
      would_buy_today: { answer: answer as OwnDraft['would_buy_today']['answer'], why },
      not_checkable: notCheckable,
      evidence: okEv.map((e) => ({ id: e.id, source_id: e.source_id, date: e.date, quote: e.quote, claim: e.claim, title: docs.get(e.source_id)?.title ?? null, url: docs.get(e.source_id)?.url ?? null })),
      report: s.report,
    },
  };
}

/** 草稿檢查沒過時寫進 issues 的前綴（draftResult 用它分辨「程式檢查沒過」與「研究員說證據不足」）。 */
export const DRAFT_ISSUE = '草稿檢查：';

/** OWN_DRAFT 的 payload 檢查（PayloadHook）：寫了草稿（DONE）而檢查不過 → 這一票改成 INSUFFICIENT、原因寫進 issues（整份退回）。 */
export function checkDraftPayload(s: CheckedSample, pack: EvidencePack, metrics: ReadonlySet<string>): void {
  if (s.verdict !== 'DONE') return;
  const r = checkDraft(s, pack, metrics);
  if (!r.errors.length) return;
  s.issues.push(...r.errors.map((e) => `${DRAFT_ISSUE}${e}`));
  s.verdict = pack.policy.abstain;
}

/**
 * 一次草擬的結果：ok = 草稿（給使用者看）；不 ok = 原因（白話，own_drafts.error）。還沒有結論是 null。
 * 只有一致（一份）寫好、檢查過的才算；逾時、沒觸發成、整份退回、格式不合格、研究員說證據不夠、程式檢查沒過都是失敗。
 */
export function draftResult(outcome: Outcome | null, pack: Pick<EvidencePack, 'documents' | 'premises' | 'rule'>, metrics: ReadonlySet<string>): { ok: true; draft: OwnDraft } | { ok: false; why: string } | null {
  if (!outcome) return null;
  const s = outcome.samples.find((x) => x.valid) ?? outcome.samples[0];
  if (outcome.status === 'AGREED' && outcome.verdict === 'DONE' && s) {
    const r = checkDraft(s, pack, metrics);
    if (r.draft) return { ok: true, draft: r.draft };
    return { ok: false, why: `程式檢查沒過：${r.errors.join('；')}` };
  }
  const bad = s?.issues.filter((x) => x.startsWith(DRAFT_ISSUE)).map((x) => x.slice(DRAFT_ISSUE.length)) ?? [];
  if (bad.length) return { ok: false, why: `程式檢查沒過：${bad.join('；')}` };
  if (outcome.status === 'INVALID') return { ok: false, why: `送回的格式不合格${s?.issues.length ? `（${s.issues.slice(0, 3).join('；')}）` : ''}` };
  if (outcome.status === 'INSUFFICIENT') return { ok: false, why: `研究員認為證據不夠寫草稿${s?.abstainReason ? `：${s.abstainReason}` : ''}` };
  return { ok: false, why: outcome.reason.replace(/，照規則。$/, '') };
}
