// 各功能自己的 payload 檢查（src/ai/check.ts 的 PayloadHook），依功能代號查。
import { XBRL_METRICS } from '../data/edgar';
import type { PayloadHook } from './check';
import { OWN_CONDITION, OWN_REVIEW, checkConditionPayload, checkOwnReviewPayload } from './ownReview';

const METRICS = new Set(Object.keys(XBRL_METRICS));

export const PAYLOAD_HOOKS: Record<string, PayloadHook> = {
  [OWN_REVIEW]: (s, pack) => checkOwnReviewPayload(s, pack, METRICS),
  [OWN_CONDITION]: (s, pack) => checkConditionPayload(s, pack),
};
