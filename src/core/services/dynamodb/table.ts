import type { Demand } from '../../sim/demand.js';
import { CapacityLane, type PartitionLaneResult } from './capacityLane.js';
import type { KeyWeights } from './keyDistribution.js';
import {
  PARTITION_MAX_READ_UNITS_PER_SEC,
  PARTITION_MAX_WRITE_UNITS_PER_SEC,
  TABLE_DEFAULT_MAX_READ_UNITS_PER_SEC,
  TABLE_DEFAULT_MAX_WRITE_UNITS_PER_SEC,
  readUnitsPerRequest,
  writeUnitsPerRequest,
} from './limits.js';
import { assignKeysToPartitions, estimatePartitionCount, foldKeyWeightsToPartitions } from './partitioning.js';

/**
 * キャパシティモードの設定。
 *
 * on-demand は「無限にスケールする」と誤解されやすいが、そんなことはない。
 * テーブル単位の上限 (既定 40,000) は残るし、
 * **1 パーティション 3,000/1,000 の物理上限は provisioned とまったく同じ**。
 * on-demand にしてもホットパーティション問題は消えない、というのが体感してほしい点。
 */
export type CapacityConfig =
  | {
      readonly mode: 'provisioned';
      readonly readCapacityUnits: number;
      readonly writeCapacityUnits: number;
    }
  | {
      /** 過去のピーク。DynamoDB はこれをもとにパーティションを用意しておく。 */
      readonly mode: 'on-demand';
      readonly peakReadUnitsPerSec: number;
      readonly peakWriteUnitsPerSec: number;
    };

export interface DynamoDbTableConfig {
  readonly capacity: CapacityConfig;
  readonly tableSizeGb: number;
  /** 項目 1 件のサイズ (KB)。これが大きいと 1 リクエストで複数ユニットを食う。 */
  readonly itemSizeKb: number;
  /** 強整合性読み取りか。結果整合性なら消費ユニットは半分。 */
  readonly consistentRead: boolean;
  readonly adaptiveCapacity: boolean;
  readonly keyWeights: KeyWeights;
}

export interface LaneTickResult {
  readonly demandedRequestsPerSec: number;
  readonly acceptedRequestsPerSec: number;
  readonly throttledRequestsPerSec: number;
  /** 0..1。1 に近いほど弾かれている。 */
  readonly throttleRate: number;
  readonly partitions: readonly PartitionLaneResult[];
}

export interface DynamoDbTickResult {
  readonly timeSeconds: number;
  readonly read: LaneTickResult;
  readonly write: LaneTickResult;
}

/**
 * DynamoDB テーブルのキャパシティモデル。
 *
 * このクラスがこのプロジェクトで最初に伝えたいことを担っている:
 *
 * > テーブル全体に 40,000 WCU を積んでも、1 つのパーティションキーに集中したら
 * > **1,000 WCU で頭打ち**になる。アダプティブキャパシティは偏りを救ってくれるが、
 * > 単一キーは分割できないので救いきれない。
 */
export class DynamoDbTable {
  readonly #config: DynamoDbTableConfig;
  readonly #partitionCount: number;
  readonly #partitionWeights: readonly number[];
  readonly #readLane: CapacityLane;
  readonly #writeLane: CapacityLane;
  readonly #readUnitsPerRequest: number;
  readonly #writeUnitsPerRequest: number;
  #elapsedSeconds = 0;

  constructor(config: DynamoDbTableConfig) {
    if (config.keyWeights.length < 1) {
      throw new RangeError('keyWeights は 1 要素以上である必要がある');
    }
    if (config.itemSizeKb <= 0) {
      throw new RangeError(`itemSizeKb は正の数である必要がある: ${config.itemSizeKb}`);
    }
    this.#config = config;

    const { tableReadCapacity, tableWriteCapacity, sizingReadUnits, sizingWriteUnits } =
      resolveCapacity(config.capacity);

    this.#partitionCount = estimatePartitionCount({
      readUnitsPerSec: sizingReadUnits,
      writeUnitsPerSec: sizingWriteUnits,
      tableSizeGb: config.tableSizeGb,
    });

    const assignment = assignKeysToPartitions(config.keyWeights.length, this.#partitionCount);
    this.#partitionWeights = foldKeyWeightsToPartitions(
      config.keyWeights,
      assignment,
      this.#partitionCount,
    );

    // on-demand は常にアダプティブキャパシティが効く（公式: adaptive capacity applies to on-demand mode）。
    const adaptive = config.capacity.mode === 'on-demand' ? true : config.adaptiveCapacity;

    this.#readLane = new CapacityLane({
      partitionCount: this.#partitionCount,
      perPartitionMaxPerSec: PARTITION_MAX_READ_UNITS_PER_SEC,
      tableCapacityPerSec: tableReadCapacity,
      adaptiveCapacity: adaptive,
    });
    this.#writeLane = new CapacityLane({
      partitionCount: this.#partitionCount,
      perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC,
      tableCapacityPerSec: tableWriteCapacity,
      adaptiveCapacity: adaptive,
    });

    this.#readUnitsPerRequest = readUnitsPerRequest(config.itemSizeKb, config.consistentRead);
    this.#writeUnitsPerRequest = writeUnitsPerRequest(config.itemSizeKb);
  }

  get partitionCount(): number {
    return this.#partitionCount;
  }

  /** 各パーティションが受け持つトラフィックの割合。合計 1。 */
  get partitionWeights(): readonly number[] {
    return this.#partitionWeights;
  }

  get readUnitsPerRequest(): number {
    return this.#readUnitsPerRequest;
  }

  get writeUnitsPerRequest(): number {
    return this.#writeUnitsPerRequest;
  }

  get elapsedSeconds(): number {
    return this.#elapsedSeconds;
  }

  /** シミュレーションを 1 tick 進める。 */
  step(demand: Demand, dtSeconds: number): DynamoDbTickResult {
    const readUnitsDemand = Math.max(0, demand.readsPerSecond) * this.#readUnitsPerRequest;
    const writeUnitsDemand = Math.max(0, demand.writesPerSecond) * this.#writeUnitsPerRequest;

    const readResult = this.#readLane.step(this.#spread(readUnitsDemand), dtSeconds);
    const writeResult = this.#writeLane.step(this.#spread(writeUnitsDemand), dtSeconds);

    this.#elapsedSeconds += dtSeconds;

    return {
      timeSeconds: this.#elapsedSeconds,
      read: toLaneTickResult(readResult, this.#readUnitsPerRequest),
      write: toLaneTickResult(writeResult, this.#writeUnitsPerRequest),
    };
  }

  /** テーブル全体の需要をパーティションごとの需要へ配分する。 */
  #spread(totalUnitsPerSec: number): number[] {
    return this.#partitionWeights.map((weight) => totalUnitsPerSec * weight);
  }
}

interface ResolvedCapacity {
  /** レーンが実際に配れるキャパシティ (units/秒)。 */
  readonly tableReadCapacity: number;
  readonly tableWriteCapacity: number;
  /** パーティション数の見積もりに使う値 (units/秒)。 */
  readonly sizingReadUnits: number;
  readonly sizingWriteUnits: number;
}

function resolveCapacity(capacity: CapacityConfig): ResolvedCapacity {
  if (capacity.mode === 'provisioned') {
    return {
      tableReadCapacity: capacity.readCapacityUnits,
      tableWriteCapacity: capacity.writeCapacityUnits,
      sizingReadUnits: capacity.readCapacityUnits,
      sizingWriteUnits: capacity.writeCapacityUnits,
    };
  }
  // on-demand: テーブル単位の既定上限まで使えるが、パーティションは過去のピークぶんしか用意されていない。
  return {
    tableReadCapacity: TABLE_DEFAULT_MAX_READ_UNITS_PER_SEC,
    tableWriteCapacity: TABLE_DEFAULT_MAX_WRITE_UNITS_PER_SEC,
    sizingReadUnits: capacity.peakReadUnitsPerSec,
    sizingWriteUnits: capacity.peakWriteUnitsPerSec,
  };
}

function toLaneTickResult(
  lane: { demandedUnitsPerSec: number; acceptedUnitsPerSec: number; throttledUnitsPerSec: number; partitions: readonly PartitionLaneResult[] },
  unitsPerRequest: number,
): LaneTickResult {
  const demanded = lane.demandedUnitsPerSec / unitsPerRequest;
  const accepted = lane.acceptedUnitsPerSec / unitsPerRequest;
  const throttled = lane.throttledUnitsPerSec / unitsPerRequest;
  return {
    demandedRequestsPerSec: demanded,
    acceptedRequestsPerSec: accepted,
    throttledRequestsPerSec: throttled,
    throttleRate: demanded > 0 ? throttled / demanded : 0,
    partitions: lane.partitions,
  };
}
