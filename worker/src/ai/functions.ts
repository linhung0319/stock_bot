// AI 功能的白話名稱與顯示方式（網站不顯示功能代號，design_v2 §10 第 30 點）。
// 各功能的證據包產生器與 prompt 在 T10、T11 加上；這裡只放共用的對照。

export interface FnInfo {
  /** 白話名稱。 */
  label: string;
  /** 網站建議單上的 AI 說明種類（src/app/site/types.ts 的 AiNote.kind）。 */
  note: 'REVIEW' | 'VETO' | 'CONDITION' | 'CRASH' | 'HARD' | null;
  /** 判斷值的白話（verdict → 文字）。 */
  verdicts: Record<string, string>;
  /** 「拿去問 AI」時預先寫好的 prompt。 */
  askPrompt: string;
}

const GENERIC_ASK =
  '你是反方審查員。請只根據這份文件裡的證據（引用、數字、原文），檢查 AI 的結論：\n' +
  '1. 每一條引用是否真的支持它旁邊寫的主張？\n' +
  '2. 結論需要的證據夠不夠？哪一條前提的判斷最站不住？\n' +
  '3. 有沒有被忽略、指向相反結論的證據？\n' +
  '不要使用文件以外的資料或自己估的數字。最後用三句話說你同不同意這個結論，以及什麼新資料會讓你改變看法。';

export const FUNCTIONS: Record<string, FnInfo> = {
  OWN_REVIEW: {
    label: '自選定期審查',
    note: 'REVIEW',
    verdicts: { EXIT: '出清', HALF: '減半', HOLD: '不動', STANDARD: '回到標準', RAISE: '提高到標準的 125%' },
    askPrompt: GENERIC_ASK + '\n另外請特別檢查：AI 是不是被最近的漲跌帶著走，或因為我的買進理由寫得很肯定就說它成立。',
  },
  OWN_CONDITION: { label: '自選條件監測', note: 'CONDITION', verdicts: { MET: '條件成立', NOT_MET: '條件沒有成立' }, askPrompt: GENERIC_ASK + '\n另外請檢查：這個條件是不是寫得太寬，新聞只是沾到邊。' },
  MOM_ENTRY: { label: '動能新股進場審查', note: 'VETO', verdicts: { ALLOW: '准許', ALLOW_WATCH: '准許但觀察', VETO: '否決', INSUFFICIENT: '證據不足（准許）' }, askPrompt: GENERIC_ASK + '\n否決只接受六種理由（被收購、一次性跳漲、盈餘背離、增資稀釋、會計問題、監管）；估值、情緒、漲太多都不算。' },
  CRASH_REVIEW: { label: '崩盤規則檢視', note: 'CRASH', verdicts: { FOLLOW: '照做', DELAY: '延後', INSUFFICIENT: '證據不足' }, askPrompt: GENERIC_ASK + '\n請先看基準率：過去跌破 200 日均線之後，真的變成空頭的比例是多少。' },
  HARD_EVENT: { label: '持股硬事件', note: 'HARD', verdicts: { EXIT: '建議提早出場', HOLD: '不用動', INSUFFICIENT: '證據不足' }, askPrompt: GENERIC_ASK + '\n請特別檢查重大性：受影響的部分占營收多少，數字有沒有出處。' },
  EVENT_SCAN: { label: '每日事件掃描', note: null, verdicts: { FLAGGED: '有標記', NOTHING: '沒有值得標的事' }, askPrompt: GENERIC_ASK + '\n請檢查：有沒有漏標的重大事件（被收購、會計問題、監管），或把例行公告標成大事。' },
  MOM_SCORE: { label: '動能前 15 名擬事件打分', note: null, verdicts: { SCORED: '已打分', INSUFFICIENT: '證據不足' }, askPrompt: GENERIC_ASK + '\n請檢查：分數是不是只反映漲多漲少，而不是前提失效的證據。' },
  OWN_DROP: { label: '自選減半檢視', note: 'REVIEW', verdicts: { EXIT: '出清', HALF: '減半（照規則）', HOLD: '不動' }, askPrompt: GENERIC_ASK + '\n請特別檢查：跌幅的歸類（大盤、產業、公司本身）有沒有被證據支持，「價格跌了」是不是被當成「論點壞了」。' },
  DROP_EXPLAIN: { label: '持股單月大跌說明', note: null, verdicts: { EXPLAINED: '已說明', INSUFFICIENT: '證據不足' }, askPrompt: GENERIC_ASK },
  STRATEGY_REVIEW: { label: '策略檢討說明', note: null, verdicts: { DONE: '已列出正反證據', INSUFFICIENT: '證據不足' }, askPrompt: GENERIC_ASK + '\n請特別檢查：正反兩邊的證據是不是一樣認真；有沒有暗示該停用或該繼續。' },
  OWN_CHECK: { label: '新增自選健檢', note: null, verdicts: { DONE: '完成', INSUFFICIENT: '證據不足' }, askPrompt: GENERIC_ASK + '\n請檢查：草擬的前提是不是證據包看得到的事；改寫的出場條件有沒有忠於我原本的意思。' },
  TEST: { label: '測試', note: null, verdicts: {}, askPrompt: GENERIC_ASK },
};

export function fnInfo(fn: string): FnInfo {
  return FUNCTIONS[fn] ?? { label: fn, note: null, verdicts: {}, askPrompt: GENERIC_ASK };
}

export const verdictText = (fn: string, v: string | null): string => (v === null ? '—' : (fnInfo(fn).verdicts[v] ?? v));
