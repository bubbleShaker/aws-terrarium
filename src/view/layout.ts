/**
 * 空間の配置と寸法。**three.js に依存しない純粋な計算だけ**を置く。
 *
 * 色 (three.js の Color が要る) は palette.ts に分けてある。
 * 分けているのは、柱の高さの写し方のような「教材の主張そのもの」を担う関数を、
 * ブラウザ抜きの単体テストで固定できるようにするため。
 */

export const COLUMN_SPACING = 1.5;
export const COLUMN_WIDTH = 0.86;
/** 内側（受理された量）の柱の太さ。外側の半透明な柱の中に収まる。 */
export const ACCEPTED_WIDTH = 0.5;
/** 需要が物理上限ちょうどのときの柱の高さ。この高さに基準面を張る。 */
export const HEIGHT_AT_HARD_CAP = 2;
/** 粒子が降ってくる高さ。クライアント側を表す。 */
export const SOURCE_HEIGHT = 7.5;
/** 柱が数本しかないときでもカメラが引く距離の下限。 */
const MIN_GRID_EXTENT = 6;

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
  // 下限を設けているのは、パーティションが 1 本しかないテーブル (big-item-trap) で
  // カメラが柱に貼りつき、頂上が画角から外れるのを防ぐため。
  return Math.max(MIN_GRID_EXTENT, Math.ceil(Math.sqrt(count)) * COLUMN_SPACING);
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

/** 指数的な追従。フレーム時間に依存せず同じ速さで滑らかになる。 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}
