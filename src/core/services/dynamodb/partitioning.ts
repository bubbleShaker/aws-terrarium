import { hashString } from '../../sim/rng.js';
import type { KeyWeights } from './keyDistribution.js';
import {
  PARTITION_MAX_READ_UNITS_PER_SEC,
  PARTITION_MAX_WRITE_UNITS_PER_SEC,
  PARTITION_SIZE_ESTIMATE,
} from './limits.js';

/** パーティションキーの表示名。ハッシュの入力にもなるので 1 箇所に固定しておく。 */
export function defaultKeyLabel(keyIndex: number): string {
  return `key-${keyIndex}`;
}

/**
 * テーブルが持つパーティション数を推定する。
 *
 * 公式に式として書かれてはいないが、以下の制約から導出できる:
 *   - 1 パーティションは 3,000 read units/秒 しか出せない
 *   - 1 パーティションは 1,000 write units/秒 しか出せない
 *   - 1 パーティションのストレージ容量には上限がある (⚠️ 10GB は推定値。limits.ts 参照)
 *
 * 落とし穴: **一度増えたパーティションは、スループットを下げても減らない**。
 * 一時的にプロビジョニングを上げると、後で 1 パーティションあたりの取り分が
 * 恒久的に細るという古典的な事故がこれで起きる。
 */
export function estimatePartitionCount(input: {
  readonly readUnitsPerSec: number;
  readonly writeUnitsPerSec: number;
  readonly tableSizeGb: number;
}): number {
  const byRead = Math.ceil(input.readUnitsPerSec / PARTITION_MAX_READ_UNITS_PER_SEC);
  const byWrite = Math.ceil(input.writeUnitsPerSec / PARTITION_MAX_WRITE_UNITS_PER_SEC);
  const bySize = Math.ceil(input.tableSizeGb / PARTITION_SIZE_ESTIMATE.value);
  return Math.max(1, byRead, byWrite, bySize);
}

/**
 * キーをパーティションへ割り当てる。返り値の index がキー、値がパーティション番号。
 *
 * 乱数ではなくハッシュを使うのは「同じキーは常に同じパーティションへ」が必須だから。
 * 実際の DynamoDB もパーティションキーの内部ハッシュ値で格納先を決めている。
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

/**
 * 各パーティションが今この瞬間に使える持続レート (units/秒) を決める。
 *
 * - アダプティブ OFF: テーブル全体のキャパシティを頭割り。パーティション上限で頭打ち。
 * - アダプティブ ON : 需要のある所へ寄せる。ただし**パーティション上限は絶対に超えられない**。
 *
 * 後者が「アダプティブキャパシティは偏りを救うが、単一ホットキーは救えない」の正体。
 * 救えるのは「テーブル全体には余裕があるのに頭割りのせいで足りない」ケースだけであって、
 * パーティション上限そのものに当たっている場合は打つ手がない。
 */
export function allocateCapacity(input: {
  readonly demandPerPartition: readonly number[];
  readonly tableCapacityPerSec: number;
  readonly perPartitionMaxPerSec: number;
  readonly adaptive: boolean;
}): number[] {
  const { demandPerPartition, tableCapacityPerSec, perPartitionMaxPerSec, adaptive } = input;
  const partitionCount = demandPerPartition.length;
  if (partitionCount === 0) return [];

  if (!adaptive) {
    const evenShare = Math.min(tableCapacityPerSec / partitionCount, perPartitionMaxPerSec);
    return new Array<number>(partitionCount).fill(evenShare);
  }

  // 各パーティションが受け取りうる上限 = 需要とパーティション上限の小さい方。
  // 需要を超えて配っても無駄なので、需要で頭を打たせて余りを他へ回す。
  const ceilings = demandPerPartition.map((demand) =>
    Math.min(Math.max(demand, 0), perPartitionMaxPerSec),
  );
  return maxMinFairShare(ceilings, tableCapacityPerSec);
}

/**
 * max-min fair 配分。全員に均等に配り、上限に達した者から抜けて残りを再分配する。
 *
 * なぜこの方式か: 「需要に比例して配る」だと、需要の小さいパーティションが
 * 満たせるはずの量すら貰えなくなる。max-min fair なら
 * 「小さい需要は必ず満たされ、余りが大きい需要へ回る」という直感に合う挙動になる。
 * アダプティブキャパシティの実装そのものではなく、あくまでモデルである点に注意。
 */
function maxMinFairShare(ceilings: readonly number[], total: number): number[] {
  const n = ceilings.length;
  const allocation = new Array<number>(n).fill(0);
  let remaining = Math.max(0, total);

  const pending = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    if ((ceilings[i] ?? 0) > 0) pending.add(i);
  }

  const epsilon = 1e-9;
  while (remaining > epsilon && pending.size > 0) {
    const share = remaining / pending.size;
    let distributed = 0;

    for (const i of [...pending]) {
      const headroom = (ceilings[i] ?? 0) - (allocation[i] ?? 0);
      const give = Math.min(share, headroom);
      if (give > 0) {
        allocation[i] = (allocation[i] ?? 0) + give;
        remaining -= give;
        distributed += give;
      }
      if ((ceilings[i] ?? 0) - (allocation[i] ?? 0) <= epsilon) pending.delete(i);
    }

    // 誰も受け取れなかった = 全員が上限に達している。余った分は使い道がない。
    if (distributed <= epsilon) break;
  }

  return allocation;
}
