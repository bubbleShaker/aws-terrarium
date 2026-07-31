import { hashString } from '../../sim/rng.js';
import type { KeyWeights } from './keyDistribution.js';
import {
  PARTITION_MAX_READ_UNITS_PER_SEC,
  PARTITION_MAX_WRITE_UNITS_PER_SEC,
  PARTITION_SIZE_ESTIMATE_GB,
} from './limits.js';

/** パーティションキーの表示名。ハッシュの入力にもなるので 1 箇所に固定しておく。 */
export function defaultKeyLabel(keyIndex: number): string {
  return `key-${keyIndex}`;
}

/**
 * テーブルが持つパーティション数を推定する。
 *
 * ```
 * partitions = ceil( max( RCU/3000 + WCU/1000, sizeGB/10 ) )
 * ```
 *
 * **読み取りと書き込みを「和」で足している**のが要点。
 * 1 つのパーティションは読み取り容量と書き込み容量を分け合っており、
 * 「3,000 RCU も 1,000 WCU も同時に丸ごと出せる」わけではないため、
 * 必要なパーティション数は両者の合計で決まる。
 * （旧 Developer Guide に載っていた式。現行ドキュメントからは式そのものは削除されている）
 *
 * ⚠️ 未モデル化: 実際には**一度増えたパーティションはスループットを下げても減らない**。
 * 一時的にプロビジョニングを上げると 1 パーティションあたりの取り分が恒久的に細る、
 * という古典的な事故がこれで起きる。この履歴依存は M2 以降で扱う。
 */
export function estimatePartitionCount(input: {
  readonly readUnitsPerSec: number;
  readonly writeUnitsPerSec: number;
  readonly tableSizeGb: number;
}): number {
  const byThroughput =
    input.readUnitsPerSec / PARTITION_MAX_READ_UNITS_PER_SEC +
    input.writeUnitsPerSec / PARTITION_MAX_WRITE_UNITS_PER_SEC;
  const bySize = input.tableSizeGb / PARTITION_SIZE_ESTIMATE_GB;
  return Math.max(1, Math.ceil(Math.max(byThroughput, bySize)));
}

/**
 * キーをパーティションへ割り当てる。返り値の index がキー、値がパーティション番号。
 *
 * 乱数ではなくハッシュを使うのは「同じキーは常に同じパーティションへ」が必須だから。
 * 実際の DynamoDB もパーティションキーの内部ハッシュ値で格納先を決めている。
 *
 * 副産物として、ハッシュの散り方には必ずむらが出る。
 * 「キーを均等に散らしても、パーティションの負荷は完全には均等にならない」
 * という現実がここから自然に再現される。
 */
export function assignKeysToPartitions(keyCount: number, partitionCount: number): number[] {
  if (partitionCount < 1) {
    throw new RangeError(`partitionCount は 1 以上である必要がある: ${partitionCount}`);
  }
  return Array.from(
    { length: keyCount },
    (_, i) => hashString(defaultKeyLabel(i)) % partitionCount,
  );
}

/**
 * キーごとの重みを、パーティションごとの重みへ畳み込む。
 *
 * ここで「単一ホットキーが救えない」理由が構造的に現れる。
 * 1 つのキーの重みは必ず 1 つのパーティションに丸ごと乗る。
 * パーティションをいくら増やしても、そのキーの重みは分割されない。
 */
export function foldKeyWeightsToPartitions(
  keyWeights: KeyWeights,
  assignment: readonly number[],
  partitionCount: number,
): number[] {
  const weights = new Array<number>(partitionCount).fill(0);
  for (let keyIndex = 0; keyIndex < keyWeights.length; keyIndex += 1) {
    const partition = assignment[keyIndex];
    const weight = keyWeights[keyIndex];
    if (partition === undefined || weight === undefined) continue;
    weights[partition] = (weights[partition] ?? 0) + weight;
  }
  return weights;
}
