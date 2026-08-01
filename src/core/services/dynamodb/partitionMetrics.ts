import type { PartitionLaneResult } from './capacityLane.js';
import type { LaneInfo } from './table.js';

/**
 * パーティション 1 本の派生指標。
 *
 * tick 結果には「率」が入っていない（レートと残量という素の値だけ）。
 * 率の計算を読む側それぞれに書かせると、Core の集計と 3D の描画で
 * **同じ名前の指標が別々に定義される**。定義を変えたときに片方だけが古くなるので、
 * ここに 1 つだけ置いて両方から呼ぶ。
 */

/** このパーティション単体のスロットル率 (0..1)。需要が無ければ 0。 */
export function partitionThrottleRate(partition: PartitionLaneResult | undefined): number {
  if (partition === undefined) return 0;
  const demanded = partition.demandedUnitsPerSec;
  return demanded > 0 ? partition.throttledUnitsPerSec / demanded : 0;
}

/**
 * バーストの残量 (0..1)。1 = 満タン。
 *
 * まだ 1 度も tick を刻んでいない場合は満タン扱いにする
 * （`CapacityLane` が既定で満タンから始めるため）。
 */
export function partitionBurstRatio(
  partition: PartitionLaneResult | undefined,
  info: LaneInfo,
): number {
  if (info.burstCapacityUnits <= 0) return 0;
  if (partition === undefined) return 1;
  return partition.burstTokens / info.burstCapacityUnits;
}
