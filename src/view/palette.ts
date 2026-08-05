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

/** 空の色。**レーンの尾はここへ溶ける**ので、背景と同じ値であることが要る。 */
export const BACKGROUND = new Color('#080b12');

/**
 * SQS のバックログ（レーン本体）の色。
 *
 * ## ⚠️ 何件溜まっても変わらない。**これが SQS の主張そのもの**
 *
 * DynamoDB の赤熱は「需要が物理上限を越えている」、Aurora の待ち色は「待たされている」を
 * 語っている。どちらも**いま悪いことが起きている指標**に紐づいた色である。
 *
 * SQS にはその指標が存在しない。バックログが 30 万件あっても、
 * エラー率もレイテンシもスループットも健全な値を出し続ける
 * （`rejectedMessagesPerSec` は構造的に常に 0）。
 * ここでレーンを負荷や件数で色づけた瞬間、M4 の看板
 * 「**溜める。何も起きない**」が絵の上で嘘になる。
 *
 * 変化を語るのは長さ（どれだけ溜まったか）と、隣の年齢バー（唯一の警報）だけ。
 */
export const LANE_BODY = new Color('#3f7fb8');

/**
 * 最古メッセージの年齢を色にする。**保持期間に対する比**で塗る。
 *
 * DynamoDB の赤熱とも Aurora の待ち色とも別の尺度である（M3 で `waitColor` を
 * `heatColor` から分けたのと同じ理由 — 意味の違うものを同じ色で塗ると、
 * 並べたときに壊れ方の違いが消える）。
 *
 * ## ⚠️ 振り切った先を赤にしない
 *
 * 赤は 3 つの敷地を通じて「**弾かれた**」に割り当ててある。
 * SQS の消失はエラーを伴わない — `Too many connections` も
 * `ProvisionedThroughputExceededException` も出ないまま、ただ消える。
 * 同じ赤で塗ると、SQS で最も伝えたい
 * 「**エラーを伴わない唯一のデータ損失**」が「よくある拒否」に見えてしまう。
 *
 * 別系統の色（マゼンタ）にしてあるのは、
 * **エラーとは違う種類の悪いこと**が起きていると分かるようにするため。
 */
const AGE_STOPS: { at: number; color: Color }[] = [
  { at: 0, color: new Color('#2b3f63') }, // まだ新しい
  { at: 0.5, color: new Color('#d9a441') }, // 保持期間の半分を過ぎた
  { at: 0.9, color: new Color('#ff7a3d') }, // 消え始める直前
  { at: 1, color: new Color('#c04ee0') }, // 消えている（エラーの赤とは別系統）
];

export function ageColor(retentionUtilization: number, target: Color): Color {
  const first = AGE_STOPS[0];
  const last = AGE_STOPS[AGE_STOPS.length - 1];
  if (first === undefined || last === undefined) return target.set('#ffffff');

  // NaN は「振り切っている」側へ倒す（消失を静かに見逃すより安全）。
  const u = Number.isFinite(retentionUtilization) ? Math.max(0, retentionUtilization) : last.at;
  if (u >= last.at) return target.copy(last.color);

  for (let i = 1; i < AGE_STOPS.length; i += 1) {
    const prev = AGE_STOPS[i - 1];
    const next = AGE_STOPS[i];
    if (prev === undefined || next === undefined) break;
    if (u <= next.at) {
      const t = (u - prev.at) / (next.at - prev.at);
      return target.copy(prev.color).lerp(next.color, t);
    }
  }
  return target.copy(last.color);
}

/**
 * consumer の設備。**稼働率で光る**。
 *
 * ⚠️ Aurora の窓口 (`GATE_*`) と違い、consumer の数は壁ではない。
 * あちらは vCPU 2 本という**動かせない本数**が壁そのものだったが、
 * SQS の consumer は好きなだけ増やせる（増やすのが正しい手である）。
 * だから窓口の本数として描かない — 本数を並べると Aurora と同じ壁に見える。
 *
 * 唯一の壁は in-flight 約 120,000 件で、そこに当たったときだけ色で知らせる。
 */
export const CONSUMER_IDLE = new Color('#233b46');
export const CONSUMER_BUSY = new Color('#5ef2c0');
/** in-flight 上限に当たっている。**consumer を増やしても消化レートが伸びない領域**。 */
export const CONSUMER_LIMITED = new Color('#e8b23c');

