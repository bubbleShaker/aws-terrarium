import { Color } from 'three';

/**
 * 空間の見た目に関する寸法と色。View 層だけが知っていればよい定数を集める。
 * ここに Core の判断（何が上限か、何が需要か）は置かない。
 */

export const COLUMN_SPACING = 1.5;
export const COLUMN_WIDTH = 0.86;
/** 内側（受理された量）の柱の太さ。外側の半透明な柱の中に収まる。 */
export const ACCEPTED_WIDTH = 0.5;
/** 需要が物理上限ちょうどのときの柱の高さ。この高さに基準面を張る。 */
export const HEIGHT_AT_HARD_CAP = 2;
/** 粒子が降ってくる高さ。クライアント側を表す。 */
export const SOURCE_HEIGHT = 7.5;

/** 柱を格子状に並べたときの位置。パーティション数が変わると並びも変わる。 */
export function gridPositions(count: number): { x: number; z: number }[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return Array.from({ length: count }, (_, i) => ({
    x: ((i % cols) - (cols - 1) / 2) * COLUMN_SPACING,
    z: (Math.floor(i / cols) - (rows - 1) / 2) * COLUMN_SPACING,
  }));
}

/** 格子全体のおおよその一辺。カメラの初期距離を決めるのに使う。 */
export function gridExtent(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count))) * COLUMN_SPACING;
}

/**
 * 上限超過ぶんの圧縮の強さ。1 で素の log2、小さいほど強く潰す。
 * 単一ホットキー (上限の 27 倍) の柱が、初期カメラの画角に収まる値にしてある。
 */
const OVERFLOW_COMPRESSION = 0.6;

/**
 * 需要 (units/秒) を柱の高さに変換する。
 *
 * 物理上限までは線形、超えた分は対数で圧縮する。
 * 単一ホットキーでは需要が上限の 27 倍に達するので、
 * 線形のままだと柱が画面外に飛び出して「他の柱との比較」ができなくなる。
 * 上限を境に伸び方が変わることで、「壁を越えている」こと自体も形で分かる。
 */
export function columnHeight(unitsPerSec: number, hardCapUnitsPerSec: number): number {
  if (hardCapUnitsPerSec <= 0 || unitsPerSec <= 0) return 0;
  const ratio = unitsPerSec / hardCapUnitsPerSec;
  if (ratio <= 1) return ratio * HEIGHT_AT_HARD_CAP;
  return HEIGHT_AT_HARD_CAP * (1 + Math.log2(ratio) * OVERFLOW_COMPRESSION);
}

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

/** 指数的な追従。フレーム時間に依存せず同じ速さで滑らかになる。 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}
