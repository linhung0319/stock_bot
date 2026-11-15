// 各功能自己的 payload 檢查（src/ai/check.ts 的 PayloadHook），依功能代號查。
// 擬事件打分（MOM_SCORE）與單月大跌說明（DROP_EXPLAIN）T32d 起不再開（momentum_ai §3.7），沒有檢查。
import { XBRL_METRICS } from '../data/edgar';
import type { PayloadHook } from './check';
import { CRASH_REVIEW, checkCrashPayload } from './crash';
import { OWN_DROP, checkDropPayload } from './drops';
import { OWN_EARNINGS, checkEarningsPayload } from './earnings';
import { EVENT_SCAN, HARD_EVENT, checkEventScanPayload, checkHardEventPayload } from './events';
import { MOM_ENTRY, checkMomEntryPayload } from './momEntry';
import { OWN_CHECK, checkOwnCheckPayload } from './ownCheck';
import { OWN_CONDITION, OWN_REVIEW, checkConditionPayload, checkOwnReviewPayload } from './ownReview';
import { STRATEGY_REVIEW, checkStrategyPayload } from './strategy';

const METRICS = new Set(Object.keys(XBRL_METRICS));

export const PAYLOAD_HOOKS: Record<string, PayloadHook> = {
  [OWN_REVIEW]: (s, pack) => checkOwnReviewPayload(s, pack, METRICS),
  [OWN_CONDITION]: (s, pack) => checkConditionPayload(s, pack),
  [EVENT_SCAN]: (s, pack) => checkEventScanPayload(s, pack),
  [HARD_EVENT]: (s, pack) => checkHardEventPayload(s, pack),
  [MOM_ENTRY]: (s, pack) => checkMomEntryPayload(s, pack),
  [OWN_DROP]: (s, pack) => checkDropPayload(s, pack),
  [CRASH_REVIEW]: (s, pack) => checkCrashPayload(s, pack),
  [STRATEGY_REVIEW]: (s, pack) => checkStrategyPayload(s, pack),
  [OWN_CHECK]: (s, pack) => checkOwnCheckPayload(s, pack, METRICS),
  [OWN_EARNINGS]: (s) => checkEarningsPayload(s),
};
