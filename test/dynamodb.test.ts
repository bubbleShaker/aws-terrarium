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
  assignKeysToPartitions,
  estimatePartitionCount,
  foldKeyWeightsToPartitions,
} from '../src/core/services/dynamodb/partitioning.js';
import {
  AdaptiveAllocator,
  type AllocatorContext,
  type CapacityAllocator,
  EvenSplitAllocator,
  evenShareRatePerSec,
} from '../src/core/services/dynamodb/allocator.js';
import { DynamoDbTable, type DynamoDbTableConfig } from '../src/core/services/dynamodb/table.js';

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

  it('読み取りと書き込みは「和」で効く（1 パーティションが両方を分け合うため）', () => {
    // 12,000 RCU = 4 パーティション相当、40,000 WCU = 40 パーティション相当。
    // max なら 40 だが、実際には両方を同時に賄う必要があるので 44。
    expect(
      estimatePartitionCount({ readUnitsPerSec: 12_000, writeUnitsPerSec: 40_000, tableSizeGb: 1 }),
    ).toBe(44);
  });

  it('スループット由来とストレージ由来では大きい方が採用される', () => {
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

describe('CapacityAllocator', () => {
  const context = {
    partitionCount: 4,
    tableCapacityPerSec: 4_000,
    perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC,
  };

  it('evenShareRatePerSec は頭割りの取り分を返し、パーティション上限を超えない', () => {
    expect(evenShareRatePerSec(context)).toBe(1_000);
    expect(
      evenShareRatePerSec({ ...context, tableCapacityPerSec: 100_000 }),
    ).toBe(PARTITION_MAX_WRITE_UNITS_PER_SEC);
    expect(evenShareRatePerSec({ ...context, tableCapacityPerSec: 400 })).toBe(100);
  });

  it('EvenSplit は需要に関係なく頭割り', () => {
    const allocator = new EvenSplitAllocator(context);
    expect(allocator.allocate([900, 100, 0, 0])).toEqual([1_000, 1_000, 1_000, 1_000]);
    // 需要が変わっても配分は変わらない = 暇なパーティションが枠を握ったまま離さない。
    expect(allocator.allocate([0, 0, 0, 0])).toEqual([1_000, 1_000, 1_000, 1_000]);
  });

  it('Adaptive は余っているパーティションの分を需要のある方へ回す', () => {
    const allocation = new AdaptiveAllocator(context).allocate([900, 10, 10, 10]);
    // 頭割りなら 1,000 ずつだが、需要のない 3 本は 10 しか取らないので熱い所が満たされる。
    expect(allocation[0]).toBeCloseTo(900);
    expect(allocation[1]).toBeCloseTo(10);
  });

  it('Adaptive でもパーティション上限は絶対に超えられない', () => {
    const allocation = new AdaptiveAllocator({
      ...context,
      tableCapacityPerSec: 40_000,
    }).allocate([50_000, 0, 0, 0]);
    expect(allocation[0]).toBe(PARTITION_MAX_WRITE_UNITS_PER_SEC);
  });

  it('Adaptive でも配る総量はテーブルのキャパシティを超えない', () => {
    const allocation = new AdaptiveAllocator({
      ...context,
      tableCapacityPerSec: 1_000,
    }).allocate([900, 900, 900, 900]);
    expect(sum(allocation)).toBeCloseTo(1_000);
  });
});

/**
 * 契約テスト。`CapacityAllocator` は差し替え可能な拡張点なので、
 * どの実装でも守られるべき不変条件を全実装に対して回す。
 * 3 が破れるとテーブルのプロビジョニング値を超える量が通り、
 * 2 が破れるとパーティションの物理上限という本モデルの根幹が崩れる。
 */
describe.each([
  ['EvenSplitAllocator', (c: AllocatorContext) => new EvenSplitAllocator(c)],
  ['AdaptiveAllocator', (c: AllocatorContext) => new AdaptiveAllocator(c)],
] as const)('CapacityAllocator の契約: %s', (_name, create) => {
  const contexts: AllocatorContext[] = [
    { partitionCount: 4, tableCapacityPerSec: 4_000, perPartitionMaxPerSec: 1_000 },
    { partitionCount: 1, tableCapacityPerSec: 3_000, perPartitionMaxPerSec: 3_000 },
    { partitionCount: 50, tableCapacityPerSec: 20_000, perPartitionMaxPerSec: 1_000 },
    // テーブルのキャパシティがパーティション総容量を大きく上回る歪んだ設定。
    { partitionCount: 2, tableCapacityPerSec: 100_000, perPartitionMaxPerSec: 1_000 },
  ];

  const demands = (n: number): readonly number[][] => [
    new Array<number>(n).fill(0),
    new Array<number>(n).fill(500),
    new Array<number>(n).fill(1_000_000),
    Array.from({ length: n }, (_, i) => (i === 0 ? 1_000_000 : 0)),
    Array.from({ length: n }, (_, i) => i * 137),
    // 契約は入力配列の長さに依存しない。短すぎる入力でも壊れないこと。
    [],
  ];

  it.each(contexts)('不変条件を満たす: %o', (context) => {
    const allocator: CapacityAllocator = create(context);
    for (const demand of demands(context.partitionCount)) {
      const allocation = allocator.allocate(demand);

      // 契約 1: 長さは partitionCount と一致する
      expect(allocation).toHaveLength(context.partitionCount);

      for (const value of allocation) {
        // 契約 2: 各要素は 0 以上 perPartitionMaxPerSec 以下
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(context.perPartitionMaxPerSec + 1e-9);
        expect(Number.isFinite(value)).toBe(true);
      }

      // 契約 3: 合計は tableCapacityPerSec を超えない
      expect(sum(allocation)).toBeLessThanOrEqual(context.tableCapacityPerSec + 1e-9);
    }
  });
});

describe('DynamoDbTable', () => {
  const baseConfig = {
    capacity: {
      mode: 'provisioned',
      readCapacityUnits: 1_000,
      writeCapacityUnits: 40_000,
      adaptiveCapacity: true,
    },
    tableSizeGb: 10,
    itemSizeKb: 1,
    consistentRead: true,
  } as const satisfies Omit<DynamoDbTableConfig, 'keyWeights'>;

  it('1,000 RCU + 40,000 WCU なら 41 パーティションになる（読み書きの和）', () => {
    const table = new DynamoDbTable({ ...baseConfig, keyWeights: uniformWeights(500) });
    expect(table.partitionCount).toBe(41);
  });

  it('キーが均等で、余裕を持って使えばスロットルは起きない', () => {
    const table = new DynamoDbTable({ ...baseConfig, keyWeights: uniformWeights(500) });
    const result = table.step({ readsPerSecond: 0, writesPerSecond: 24_000 }, 1);
    expect(result.write.throttleRate).toBeLessThan(0.001);
  });

  it('キーが均等でも、プロビジョニング値に近づくと最も重いパーティションが物理上限に当たる', () => {
    // 500 キーを 41 パーティションへハッシュで配ると、最大 17 キーを抱える本が出る
    // (重み 0.0340 × 500)。理想は 12.2 キー。
    // 均等に「設計」しても、実際の負荷は均等に「ならない」。
    const table = new DynamoDbTable({ ...baseConfig, keyWeights: uniformWeights(500) });
    const result = table.step({ readsPerSecond: 0, writesPerSecond: 40_000 }, 1);
    expect(result.write.throttleRate).toBeGreaterThan(0.01);

    const hottest = hottestPartition(result);
    expect(hottest.demandedUnitsPerSec).toBeGreaterThan(PARTITION_MAX_WRITE_UNITS_PER_SEC);
    expect(hottest.acceptedUnitsPerSec).toBeLessThanOrEqual(PARTITION_MAX_WRITE_UNITS_PER_SEC + 1e-6);
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
    const cases: Partial<DynamoDbTableConfig>[] = [
      { itemSizeKb: 0 },
      { itemSizeKb: Number.NaN },
      { keyWeights: [] },
      { tableSizeGb: -1 },
      { tableSizeGb: Number.NaN },
      { initialBurstTokens: -1 },
      { capacity: { mode: 'provisioned', readCapacityUnits: -1_000, writeCapacityUnits: 100, adaptiveCapacity: true } },
      { capacity: { mode: 'on-demand', peakReadUnitsPerSec: 100, peakWriteUnitsPerSec: Number.NaN } },
    ];
    for (const override of cases) {
      expect(
        () => new DynamoDbTable({ ...baseConfig, keyWeights: uniformWeights(500), ...override }),
        JSON.stringify(override),
      ).toThrow(RangeError);
    }
  });

  it('on-demand ではアダプティブキャパシティが常に有効になる', () => {
    const table = new DynamoDbTable({
      ...baseConfig,
      capacity: { mode: 'on-demand', peakReadUnitsPerSec: 1_000, peakWriteUnitsPerSec: 40_000 },
      keyWeights: uniformWeights(500),
    });
    expect(table.adaptiveCapacity).toBe(true);
  });

  it('on-demand でもパーティションの物理上限は provisioned とまったく同じ', () => {
    const table = new DynamoDbTable({
      ...baseConfig,
      capacity: { mode: 'on-demand', peakReadUnitsPerSec: 1_000, peakWriteUnitsPerSec: 40_000 },
      keyWeights: singleHotWeights(500, 0.9),
      initialBurstTokens: 0,
    });
    const last = advance(table, 30_000, 60);
    const hottest = hottestPartition(last);
    // on-demand にしても 1,000 WCU の壁は消えない。
    expect(hottest.acceptedUnitsPerSec).toBeLessThanOrEqual(PARTITION_MAX_WRITE_UNITS_PER_SEC + 1e-6);
    expect(hottest.throttledUnitsPerSec).toBeGreaterThan(0);
  });

  /**
   * 回帰テスト。
   *
   * かつて、アダプティブ ON のときバーストの貯金が二度と回復しないバグがあった。
   * 原因は貯金の補充量を「アダプティブの配分 − 使用量」で計算していたこと。
   * アダプティブの配分は必ず需要以下になるため、この差は恒久的に 0 になっていた。
   * 貯金は「頭割りの取り分 (払っている分) − 使用量」から貯まるのが正しい。
   */
  it.each([true, false])(
    'アダプティブ %s: バーストを使い切っても、暇になれば貯金は回復する',
    (adaptiveCapacity) => {
      const config = {
        ...baseConfig,
        capacity: { ...baseConfig.capacity, adaptiveCapacity },
        keyWeights: uniformWeights(500),
        initialBurstTokens: 0,
      } satisfies DynamoDbTableConfig;
      const table = new DynamoDbTable(config);

      // まず飽和させて貯金を空にする。
      const saturated = advance(table, 200_000, 300);
      const afterSaturation = totalBurstTokens(saturated);

      // 次に完全に暇にする。
      const idle = advance(table, 0, 600);
      const afterIdle = totalBurstTokens(idle);

      expect(afterSaturation).toBeLessThan(1);
      expect(afterIdle).toBeGreaterThan(afterSaturation);
      // 300 秒以上暇にしたので満タンまで戻っているはず。
      const baseline = 40_000 / table.partitionCount;
      expect(afterIdle).toBeCloseTo(baseline * 300 * table.partitionCount, 0);
    },
  );

  it('バーストの貯金があるとスパイクを吸収できるが、貯金ゼロだと即スロットルする', () => {
    // 頭割りの取り分 (200) を超えるが、物理上限 (1,000) には届かない需要を作る。
    // 物理上限に当たってしまうと貯金では救えず、この対比が成立しない。
    const build = (initialBurstTokens: number): DynamoDbTable =>
      new DynamoDbTable({
        capacity: {
          mode: 'provisioned',
          readCapacityUnits: 0,
          writeCapacityUnits: 10_000,
          adaptiveCapacity: false,
        },
        tableSizeGb: 500, // → 50 パーティション、頭割りの取り分は 200 WCU
        itemSizeKb: 1,
        consistentRead: true,
        keyWeights: uniformWeights(500),
        initialBurstTokens,
      });

    const withBurst = build(1_000_000).step({ readsPerSecond: 0, writesPerSecond: 15_000 }, 1);
    const withoutBurst = build(0).step({ readsPerSecond: 0, writesPerSecond: 15_000 }, 1);

    expect(withBurst.write.throttleRate).toBeLessThan(0.001);
    expect(withoutBurst.write.throttleRate).toBeGreaterThan(0.3);
  });
});

/** `seconds` 秒ぶん 1 秒 tick で進めて、最後の結果を返す。 */
function advance(table: DynamoDbTable, writesPerSecond: number, seconds: number) {
  let last = table.step({ readsPerSecond: 0, writesPerSecond }, 1);
  for (let i = 1; i < seconds; i += 1) {
    last = table.step({ readsPerSecond: 0, writesPerSecond }, 1);
  }
  return last;
}

function hottestPartition(tick: { write: { partitions: readonly { demandedUnitsPerSec: number }[] } }) {
  return [...tick.write.partitions].sort(
    (a, b) => b.demandedUnitsPerSec - a.demandedUnitsPerSec,
  )[0]! as (typeof tick)['write']['partitions'][number] & {
    acceptedUnitsPerSec: number;
    throttledUnitsPerSec: number;
  };
}

function totalBurstTokens(tick: { write: { partitions: readonly { burstTokens: number }[] } }): number {
  return tick.write.partitions.reduce((total, p) => total + p.burstTokens, 0);
}
