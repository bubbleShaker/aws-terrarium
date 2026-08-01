import { Color } from 'three';

/**
 * 空間の配色。three.js の Color を扱うのはこのファイルだけ。
 * 配置と寸法は layout.ts にある。
 */

/** 赤熱の色見本。`utilizationVsHardCap` を色に写す。 */
const HEAT_STOPS: { at: number; color: Color }[] = [
  { at: 0, color: new Color('#16324f') }, // 冷たい: 需要がほぼ無い
  { at: 0.4, color: new Color('#1c7f8f') },
  { at: 0.75, color: new Color('#d9a441') }, // 上限が見えてきた
  { at: 1, color: new Color('#e2593c') }, // 物理上限ちょうど
  { at: 2.5, color: new Color('#ff2a14') }, // 振り切っている
];

/**
 * 需要と物理上限の比を色にする。
 *
 * **指標に `utilizationVsBaseline` ではなく `utilizationVsHardCap` を使うのが肝**。
 * 頭割りの取り分は増やせるが、物理上限との距離は誰にも縮められない。
 * 「もう打つ手がない」を色で伝えるための選択（PLAN.md「M2 で必ず踏む設計判断 3」）。
 */
export function heatColor(utilizationVsHardCap: number, target: Color): Color {
  const u = Number.isFinite(utilizationVsHardCap) ? Math.max(0, utilizationVsHardCap) : 99;
  const last = HEAT_STOPS[HEAT_STOPS.length - 1];
  if (last === undefined) return target.set('#ffffff');
  if (u >= last.at) return target.copy(last.color);

  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    const prev = HEAT_STOPS[i - 1];
    const next = HEAT_STOPS[i];
    if (prev === undefined || next === undefined) break;
    if (u <= next.at) {
      const t = (u - prev.at) / (next.at - prev.at);
      return target.copy(prev.color).lerp(next.color, t);
    }
  }
  return target.copy(last.color);
}

/**
 * 受理された量を表す内側の柱の色。
 *
 * スロットル中でも**赤にはしない**。外側の柱が既に赤熱しているので、
 * 内側まで赤くすると全部が赤一色になり、「需要」と「通った量」の差が消える。
 * 頭打ちは黄色で示し、赤は「需要が物理上限を越えている」ことだけに使う。
 */
const ACCEPTED_HEALTHY = new Color('#5ef2c0');
const ACCEPTED_THROTTLED = new Color('#ffd166');

export function acceptedColor(throttleRate: number, target: Color): Color {
  return target.copy(ACCEPTED_HEALTHY).lerp(ACCEPTED_THROTTLED, Math.min(1, throttleRate * 1.6));
}

/**
 * Aurora のレイテンシを色にする。
 *
 * **DynamoDB の赤熱 (`heatColor`) とは別の尺度で塗る**。
 * あちらの赤は「需要が物理上限を越えている」、こちらの色は「待たされている」で、
 * 意味が違うものを同じ色で塗ると、並べたときに壊れ方の違いが消える。
 *
 * 目盛りは 10 倍ごとに取ってある。ミリ秒から秒への 3 桁を線形で塗ると、
 * 「まだ 50ms なのに既に 10 倍遅い」という飽和前の劣化が全部同じ色に潰れるため。
 */
const WAIT_STOPS: { at: number; color: Color }[] = [
  { at: 0.005, color: new Color('#3fd6ff') }, // 5ms: 待っていない
  { at: 0.05, color: new Color('#5ef2c0') }, // 50ms: ゆらぎで待ち始めた
  { at: 0.5, color: new Color('#d9a441') }, // 500ms: 人間が気づく
  { at: 5, color: new Color('#ff2a14') }, // 5s: タイムアウトの領域
];

export function waitColor(latencySeconds: number, target: Color): Color {
  const first = WAIT_STOPS[0];
  const last = WAIT_STOPS[WAIT_STOPS.length - 1];
  if (first === undefined || last === undefined) return target.set('#ffffff');

  const seconds = Number.isFinite(latencySeconds) ? latencySeconds : last.at;
  if (seconds <= first.at) return target.copy(first.color);
  if (seconds >= last.at) return target.copy(last.color);

  for (let i = 1; i < WAIT_STOPS.length; i += 1) {
    const prev = WAIT_STOPS[i - 1];
    const next = WAIT_STOPS[i];
    if (prev === undefined || next === undefined) break;
    if (seconds <= next.at) {
      // 対数で補間する。目盛りが 10 倍刻みなので、線形に混ぜると上の桁に偏る。
      const t = Math.log(seconds / prev.at) / Math.log(next.at / prev.at);
      return target.copy(prev.color).lerp(next.color, t);
    }
  }
  return target.copy(last.color);
}

/** 待合室の席。空いている席は構造として見えるが、埋まった席は主張する。 */
export const SEAT_EMPTY = new Color('#1a2433');
export const SEAT_TAKEN = new Color('#e8b23c');
/** vCPU の窓口。仕事をしている間だけ光る。 */
export const GATE_IDLE = new Color('#1f3a4d');
export const GATE_BUSY = new Color('#5ef2c0');

