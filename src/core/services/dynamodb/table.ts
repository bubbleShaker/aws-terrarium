import type { Demand } from '../../sim/demand.js';
import { type AllocatorContext, allocatorFactory } from './allocator.js';
import { CapacityLane, type LaneStepResult, type PartitionLaneResult } from './capacityLane.js';
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
 *
 * なお on-demand ではアダプティブキャパシティが常に有効なので、
 * この型には `adaptiveCapacity` 相当の設定を持たせていない
 * （持たせると「切っても効かないスイッチ」ができてしまう）。
 */
export type CapacityConfig =
  | {
      readonly mode: 'provisioned';
      readonly readCapacityUnits: number;
      readonly writeCapacityUnits: number;
      readonly adaptiveCapacity: boolean;
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
  readonly keyWeights: KeyWeights;
  /**
   * バーストの初期貯金 (units)。省略時は満タン。
   * 満タン開始は「開始前にテーブルは 300 秒以上暇だった」という想定。
   */
  readonly initialBurstTokens?: number | undefined;
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
 *
 * ## バーストとプロビジョニング値の関係（誤解しやすい点）
 *
 * 貯金を放出している間は、**テーブル全体の受理量がプロビジョニング値を数分間超える**。
 * 実測では 2,000 WCU のテーブルが 1.55 倍の 3,100 WCU を 400 秒間出す。
 * これはバグではなく、バーストキャパシティの定義そのもの
 * （暇な間に貯めた分を後で使っている）。
 *
 * 保証しているのは瞬間値ではなく**保存則**である:
 *
 * > 貯金ゼロから始めた場合、累計の受理量は
 * > 「テーブルのキャパシティ × 経過時間」を決して超えない。
 *
 * 無から容量を生み出していないことがモデルの健全性の根幹であり、
 * `test/capacityLane.test.ts` で全パターンについて検証している。
 *
 * ⚠️ モデル上の単純化: テーブル単位の**瞬間**上限は設けていない
 * （実機の会計もパーティション単位なので方向としては正しい）。
 */
export class DynamoDbTable {
  readonly #partitionCount: number;
  readonly #partitionWeights: readonly number[];
  readonly #readLane: CapacityLane;
  readonly #writeLane: CapacityLane;
  readonly #readUnitsPerRequest: number;
  readonly #writeUnitsPerRequest: number;
  readonly #adaptiveCapacity: boolean;
  #elapsedSeconds = 0;

  constructor(config: DynamoDbTableConfig) {
    validateConfig(config);

    const { tableReadCapacity, tableWriteCapacity, sizingReadUnits, sizingWriteUnits, adaptive } =
      resolveCapacity(config.capacity);
    this.#adaptiveCapacity = adaptive;

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

    this.#readLane = this.#createLane(
      { partitionCount: this.#partitionCount, tableCapacityPerSec: tableReadCapacity, perPartitionMaxPerSec: PARTITION_MAX_READ_UNITS_PER_SEC },
      adaptive,
      config.initialBurstTokens,
    );
    this.#writeLane = this.#createLane(
      { partitionCount: this.#partitionCount, tableCapacityPerSec: tableWriteCapacity, perPartitionMaxPerSec: PARTITION_MAX_WRITE_UNITS_PER_SEC },
      adaptive,
      config.initialBurstTokens,
    );

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

  /**
   * 実際に効いているアダプティブキャパシティの値。
   * on-demand では設定に関わらず常に true になるため、実効値を公開しておく。
   */
  get adaptiveCapacity(): boolean {
    return this.#adaptiveCapacity;
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

  #createLane(
    context: AllocatorContext,
    adaptive: boolean,
    initialBurstTokens: number | undefined,
  ): CapacityLane {
    return new CapacityLane({
      ...context,
      allocatorFactory: allocatorFactory(adaptive),
      initialBurstTokens,
    });
  }

  /** テーブル全体の需要をパーティションごとの需要へ配分する。 */
  #spread(totalUnitsPerSec: number): number[] {
    return this.#partitionWeights.map((weight) => totalUnitsPerSec * weight);
  }
}

function validateConfig(config: DynamoDbTableConfig): void {
  if (config.keyWeights.length < 1) {
    throw new RangeError('keyWeights は 1 要素以上である必要がある');
  }
  requirePositive(config.itemSizeKb, 'itemSizeKb');
  requireNonNegative(config.tableSizeGb, 'tableSizeGb');
  if (config.initialBurstTokens !== undefined) {
    requireNonNegative(config.initialBurstTokens, 'initialBurstTokens');
  }

  if (config.capacity.mode === 'provisioned') {
    requireNonNegative(config.capacity.readCapacityUnits, 'readCapacityUnits');
    requireNonNegative(config.capacity.writeCapacityUnits, 'writeCapacityUnits');
  } else {
    requireNonNegative(config.capacity.peakReadUnitsPerSec, 'peakReadUnitsPerSec');
    requireNonNegative(config.capacity.peakWriteUnitsPerSec, 'peakWriteUnitsPerSec');
  }
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} は正の有限数である必要がある: ${value}`);
  }
}

function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} は 0 以上の有限数である必要がある: ${value}`);
  }
}

interface ResolvedCapacity {
  /** レーンが実際に配れるキャパシティ (units/秒)。 */
  readonly tableReadCapacity: number;
  readonly tableWriteCapacity: number;
  /** パーティション数の見積もりに使う値 (units/秒)。 */
  readonly sizingReadUnits: number;
  readonly sizingWriteUnits: number;
  readonly adaptive: boolean;
}

function resolveCapacity(capacity: CapacityConfig): ResolvedCapacity {
  if (capacity.mode === 'provisioned') {
    return {
      tableReadCapacity: capacity.readCapacityUnits,
      tableWriteCapacity: capacity.writeCapacityUnits,
      sizingReadUnits: capacity.readCapacityUnits,
      sizingWriteUnits: capacity.writeCapacityUnits,
      adaptive: capacity.adaptiveCapacity,
    };
  }
  // on-demand: テーブル単位の既定上限まで使えるが、
  // パーティションは過去のピークぶんしか用意されていない。
  // アダプティブキャパシティは常に有効（公式: adaptive capacity applies to on-demand mode）。
  return {
    tableReadCapacity: TABLE_DEFAULT_MAX_READ_UNITS_PER_SEC,
    tableWriteCapacity: TABLE_DEFAULT_MAX_WRITE_UNITS_PER_SEC,
    sizingReadUnits: capacity.peakReadUnitsPerSec,
    sizingWriteUnits: capacity.peakWriteUnitsPerSec,
    adaptive: true,
  };
}

function toLaneTickResult(lane: LaneStepResult, unitsPerRequest: number): LaneTickResult {
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
