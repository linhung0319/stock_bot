// 核心比例橫條的位置算法（不碰 DOM，測試直接 import）：
// 刻度與白點用「占整條的百分比」定位；各段的 flex 用千分比整數（小數加總不到 1 的話 flex 拉不滿一行）。
const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const barPct = (x, max) => Math.round(clamp01(x / max) * 10000) / 100;
export const segFlex = (s) => Math.round((s.to - s.from) * 1000);
/** c：後端的 CoreBar。回傳每個刻度、白點的 left（%）與每段的 flex。 */
export function corebarPos(c) {
  return { ticks: c.ticks.map((t) => barPct(t.at, c.max)), dot: barPct(c.s, c.max), flex: c.segs.map(segFlex) };
}
