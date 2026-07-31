import { describe, expect, it } from 'vitest';
import {
  buildKeyWeights,
  singleHotWeights,
  uniformWeights,
  zipfWeights,
} from '../src/core/services/dynamodb/keyDistribution.js';
import {
  PARTITION_MAX_READ_UNITS_PER_SEC,
  PARTITION_MAX_WRITE_UNITS_PER_SEC,
  readUnitsPerRequest,
  writeUnitsPerRequest,
} from '../src/core/services/dynamodb/limits.js';
import {
  allocateCapacity,
  assignKeysToPartitions,
  estimatePartitionCount,
  foldKeyWeightsToPartitions,
} from '../src/core/services/dynamodb/partitioning.js';
import { DynamoDbTable } from '../src/core/services/dynamodb/table.js';

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

describe('keyDistribution', () => {
  it('どの分布でも重みの合計は 1 になる', () => {
    for (const weights of [
      uniformWeights(100),
      zipfWeights(100, 1),
      singleHotWeights(100, 0.9),
    ]) {
      expect(sum(weights)).toBeCloseTo(1, 10);
    }
  });

  it('uniform は全キーが同じ重み', () => {
    const weights = uniformWeights(4);
    expect(weights).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('zipf は先頭ほど重く、単調に減る', () => {
    const weights = zipfWeights(50, 1);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]!).toBeLessThan(weights[i - 1]!);
    }
  });

  it('zipf の skew=0 は uniform と一致する', () => {
    expect(zipfWeights(10, 0)).toEqual(uniformWeights(10));
  });

  it('singleHot は先頭キーに hotRatio が乗り、残りは均等に散る', () => {
    const weights = singleHotWeights(5, 0.8);
    expect(weights[0]).toBeCloseTo(0.8);
    expect(weights[1]).toBeCloseTo(0.05);
    expect(weights[4]).toBeCloseTo(0.05);
  });

  it('不正な入力は弾く', () => {
    expect(() => uniformWeights(0)).toThrow(RangeError);
    expect(() => zipfWeights(10, -1)).toThrow(RangeError);
    expect(() => singleHotWeights(10, 1.5)).toThrow(RangeError);
  });

  it('buildKeyWeights が仕様から正しい分布を作る', () => {
    expect(buildKeyWeights({ kind: 'uniform' }, 4)).toEqual(uniformWeights(4));
    expect(buildKeyWeights({ kind: 'zipf', skew: 1 }, 4)).toEqual(zipfWeights(4, 1));
    expect(buildKeyWeights({ kind: 'singleHot', hotRatio: 0.9 }, 4)).toEqual(
      singleHotWeights(4, 0.9),
    );
  });
});

describe('limits', () => {
  it('4KB 以下の強整合性読み取りは 1 read unit', () => {
    expect(readUnitsPerRequest(4, true)).toBe(1);
    expect(readUnitsPerRequest(1, true)).toBe(1);
  });

  it('20KB の項目は 1 回の読み取りで 5 read units を食う（公式ドキュメントの例）', () => {
    expect(readUnitsPerRequest(20, true)).toBe(5);
    // 3,000 read units / 5 = 秒 600 リクエストが 1 パーティションの限界。
    expect(PARTITION_MAX_READ_UNITS_PER_SEC / readUnitsPerRequest(20, true)).toBe(600);
  });

  it('結果整合性読み取りは強整合性の半分で済む', () => {
    expect(readUnitsPerRequest(20, false)).toBe(2.5);
  });

  it('書き込みは 1KB 単位で切り上げる', () => {
    expect(writeUnitsPerRequest(1)).toBe(1);
    expect(writeUnitsPerRequest(1.2)).toBe(2);
    expect(writeUnitsPerRequest(20)).toBe(20);
  });
});

describe('estimatePartitionCount', () => {
  it('読み取り上限からパーティション数が決まる', () => {
    expect(
      estimatePartitionCount({ readUnitsPerSec: 12_000, writeUnitsPerSec: 0, tableSizeGb: 1 }),
    ).toBe(4);
  });

  it('書き込み上限からパーティション数が決まる', () => {
    expect(
      estimatePartitionCount({ readUnitsPerSec: 0, writeUnitsPerSec: 40_000, tableSizeGb: 1 }),
    ).toBe(40);
  });

  it('ストレージ量からパーティション数が決まる', () => {
    expect(
      estimatePartitionCount({ readUnitsPerSec: 0, writeUnitsPerSec: 0, tableSizeGb: 500 }),
    ).toBe(50);
  });

  it('3 つの制約のうち最大のものが採用される', () => {
    expect(
      estimatePartitionCount({ readUnitsPerSec: 12_000, writeUnitsPerSec: 40_000, tableSizeGb: 500 }),
    ).toBe(50);
  });

  it('最低 1 パーティションは必ずある', () => {
    expect(
      estimatePartitionCount({ readUnitsPerSec: 0, writeUnitsPerSec: 0, tableSizeGb: 0 }),
    ).toBe(1);
  });
});

describe('partitioning', () => {
  it('同じキーは常に同じパーティションへ行く', () => {
    expect(assignKeysToPartitions(100, 8)).toEqual(assignKeysToPartitions(100, 8));
  });

  it('割り当て先は必ずパーティション数の範囲内', () => {
    for (const partition of assignKeysToPartitions(500, 40)) {
      expect(partition).toBeGreaterThanOrEqual(0);
      expect(partition).toBeLessThan(40);
    }
  });

  it('キーの重みを畳み込んでもトラフィックの総量は保存される', () => {
    const weights = zipfWeights(500, 0.7);
    const assignment = assignKeysToPartitions(500, 40);
    expect(sum(foldKeyWeightsToPartitions(weights, assignment, 40))).toBeCloseTo(1, 10);
  });

  it('単一ホットキーの重みは 1 本のパーティションに丸ごと乗る（分割されない）', () => {
    const weights = singleHotWeights(500, 0.9);
    const assignment = assignKeysToPartitions(500, 40);
    const partitionWeights = foldKeyWeightsToPartitions(weights, assignment, 40);
    // どれだけパーティションを増やしても、0.9 を持つパーティションが必ず 1 本できる。
    expect(Math.max(...partitionWeights)).toBeGreaterThanOrEqual(0.9);
  });
});

describe('allocateCapacity', () => {
  it('アダプティブ OFF なら需要に関係なく頭割り', () => {
    const allocation = allocateCapacity({
      demandPerPartition: [900, 100, 0, 0],
      tableCapacityPerSec: 4_000,
      perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC,
      adaptive: false,
    });
    expect(allocation).toEqual([1_000, 1_000, 1_000, 1_000]);
  });

  it('頭割りの取り分がパーティション上限を超えることはない', () => {
    const allocation = allocateCapacity({
      demandPerPartition: [0, 0],
      tableCapacityPerSec: 100_000,
      perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC,
      adaptive: false,
    });
    expect(allocation).toEqual([1_000, 1_000]);
  });

  it('アダプティブ ON なら余っているパーティションの分が需要のある方へ回る', () => {
    const allocation = allocateCapacity({
      demandPerPartition: [900, 10, 10, 10],
      tableCapacityPerSec: 4_000,
      perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC,
      adaptive: true,
    });
    // 頭割りなら 1,000 ずつだが、需要のない 3 本は 10 しか取らないので熱い所が満たされる。
    expect(allocation[0]).toBeCloseTo(900);
    expect(allocation[1]).toBeCloseTo(10);
  });

  it('アダプティブ ON でもパーティション上限は絶対に超えられない', () => {
    const allocation = allocateCapacity({
      demandPerPartition: [50_000, 0, 0, 0],
      tableCapacityPerSec: 40_000,
      perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC,
      adaptive: true,
    });
    expect(allocation[0]).toBe(PARTITION_MAX_WRITE_UNITS_PER_SEC);
  });

  it('アダプティブ ON でも配る総量はテーブルのキャパシティを超えない', () => {
    const allocation = allocateCapacity({
      demandPerPartition: [900, 900, 900, 900],
      tableCapacityPerSec: 1_000,
      perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC,
      adaptive: true,
    });
    expect(sum(allocation)).toBeCloseTo(1_000);
  });
});

describe('DynamoDbTable', () => {
  const baseConfig = {
    capacity: { mode: 'provisioned', readCapacityUnits: 1_000, writeCapacityUnits: 40_000 },
    tableSizeGb: 10,
    itemSizeKb: 1,
    consistentRead: true,
    adaptiveCapacity: true,
  } as const;

  it('40,000 WCU なら 40 パーティションになる', () => {
    const table = new DynamoDbTable({ ...baseConfig, keyWeights: uniformWeights(500) });
    expect(table.partitionCount).toBe(40);
  });

  it('キーが均等ならスロットルは起きない', () => {
    const table = new DynamoDbTable({ ...baseConfig, keyWeights: uniformWeights(500) });
    const result = table.step({ readsPerSecond: 0, writesPerSecond: 30_000 }, 1);
    expect(result.write.throttleRate).toBeLessThan(0.001);
  });

  it('項目サイズが大きいと 1 リクエストあたりの消費ユニットが増える', () => {
    const table = new DynamoDbTable({
      ...baseConfig,
      itemSizeKb: 20,
      keyWeights: uniformWeights(500),
    });
    expect(table.readUnitsPerRequest).toBe(5);
    expect(table.writeUnitsPerRequest).toBe(20);
  });

  it('不正な設定は弾く', () => {
    expect(() => new DynamoDbTable({ ...baseConfig, itemSizeKb: 0, keyWeights: uniformWeights(1) }))
      .toThrow(RangeError);
    expect(() => new DynamoDbTable({ ...baseConfig, keyWeights: [] })).toThrow(RangeError);
  });

  it('on-demand でもパーティションの物理上限は provisioned とまったく同じ', () => {
    const table = new DynamoDbTable({
      capacity: { mode: 'on-demand', peakReadUnitsPerSec: 1_000, peakWriteUnitsPerSec: 40_000 },
      tableSizeGb: 10,
      itemSizeKb: 1,
      consistentRead: true,
      adaptiveCapacity: true,
      keyWeights: singleHotWeights(500, 0.9),
    });
    // バーストを使い切るまで回してから判定する。
    let last = table.step({ readsPerSecond: 0, writesPerSecond: 30_000 }, 1);
    for (let i = 0; i < 600; i += 1) {
      last = table.step({ readsPerSecond: 0, writesPerSecond: 30_000 }, 1);
    }
    const hottest = [...last.write.partitions].sort(
      (a, b) => b.demandedUnitsPerSec - a.demandedUnitsPerSec,
    )[0]!;
    // on-demand にしても 1,000 WCU の壁は消えない。
    expect(hottest.acceptedUnitsPerSec).toBeLessThanOrEqual(PARTITION_MAX_WRITE_UNITS_PER_SEC + 1e-6);
    expect(hottest.throttledUnitsPerSec).toBeGreaterThan(0);
  });
});
