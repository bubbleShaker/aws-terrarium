import { TokenBucket } from '../../sim/tokenBucket.js';
import { BURST_WINDOW_SECONDS } from './limits.js';
import { allocateCapacity } from './partitioning.js';

/**
 * 1 本の容量レーン（読み取り、または書き込み）。
 *
 * 読み取りと書き込みは上限値が違うだけで判定ロジックは完全に同じなので、
 * ここに 1 つだけ書いて 2 つインスタンス化する。
 */
export interface PartitionLaneResult {
  readonly index: number;
  /** 需要 (units/秒) */
  readonly demandedUnitsPerSec: number;
  /** 通った量 (units/秒) */
  readonly acceptedUnitsPerSec: number;
  /** 弾かれた量 (units/秒) */
  readonly throttledUnitsPerSec: number;
  /** この tick に使えた持続レート (units/秒) */
  readonly allowanceUnitsPerSec: number;
  /** バーストの残り貯金 (units) */
  readonly burstTokens: number;
  /** 需要 / 持続レート。1 を超えたらバーストを食い始めている。 */
  readonly utilization: number;
}

export interface LaneStepResult {
  readonly demandedUnitsPerSec: number;
  readonly acceptedUnitsPerSec: number;
  readonly throttledUnitsPerSec: number;
  readonly partitions: readonly PartitionLaneResult[];
}

export interface CapacityLaneConfig {
  readonly partitionCount: number;
  /** 1 パーティションの物理上限 (units/秒)。3,000 (read) または 1,000 (write)。 */
  readonly perPartitionMaxPerSec: number;
  /** テーブル全体で使えるキャパシティ (units/秒)。 */
  readonly tableCapacityPerSec: number;
  readonly adaptiveCapacity: boolean;
}

export class CapacityLane {
  readonly #config: CapacityLaneConfig;
  readonly #buckets: readonly TokenBucket[];
  /** 頭割りしたときの 1 パーティションあたりの取り分 (units/秒)。 */
  readonly #baselineRatePerSec: number;

  constructor(config: CapacityLaneConfig) {
    if (config.partitionCount < 1) {
      throw new RangeError(`partitionCount は 1 以上である必要がある: ${config.partitionCount}`);
    }
    this.#config = config;
    this.#baselineRatePerSec = Math.min(
      config.tableCapacityPerSec / config.partitionCount,
      config.perPartitionMaxPerSec,
    );
    // バーストの貯金枠は「払っている分」= 頭割りの取り分から決まる。
    // アダプティブで一時的に取り分が増えても、貯金枠まで増えるわけではない。
    const burstCapacity = this.#baselineRatePerSec * BURST_WINDOW_SECONDS;
    this.#buckets = Array.from(
      { length: config.partitionCount },
      () => new TokenBucket(burstCapacity, burstCapacity),
    );
  }

  get baselineRatePerSec(): number {
    return this.#baselineRatePerSec;
  }

  /**
   * 1 tick 進める。`demandPerPartition` はパーティションごとの需要 (units/秒)。
   */
  step(demandPerPartition: readonly number[], dtSeconds: number): LaneStepResult {
    if (dtSeconds <= 0) {
      throw new RangeError(`dtSeconds は正の数である必要がある: ${dtSeconds}`);
    }

    const allowance = allocateCapacity({
      demandPerPartition,
      tableCapacityPerSec: this.#config.tableCapacityPerSec,
      perPartitionMaxPerSec: this.#config.perPartitionMaxPerSec,
      adaptive: this.#config.adaptiveCapacity,
    });

    const partitions: PartitionLaneResult[] = [];
    let totalDemanded = 0;
    let totalAccepted = 0;

    for (let i = 0; i < this.#config.partitionCount; i += 1) {
      const bucket = this.#buckets[i];
      if (bucket === undefined) continue;

      const demandRate = Math.max(0, demandPerPartition[i] ?? 0);
      const allowanceRate = this.#config.adaptiveCapacity
        ? (allowance[i] ?? 0)
        : this.#baselineRatePerSec;

      const demandUnits = demandRate * dtSeconds;
      // バーストの貯金を使っても、パーティションの物理上限は絶対に超えられない。
      // 「バーストがあるから 1,000 WCU の壁を越えられる」わけではない、という肝。
      const hardCapUnits = this.#config.perPartitionMaxPerSec * dtSeconds;
      const allowedUnits = Math.min(demandUnits, hardCapUnits);

      const sustainedUnits = allowanceRate * dtSeconds;
      const sustainedUsed = Math.min(allowedUnits, sustainedUnits);

      // 使い切らなかった持続分が貯金になる。
      bucket.refill(sustainedUnits - sustainedUsed);
      const fromBurst = bucket.consume(allowedUnits - sustainedUsed);

      const acceptedUnits = sustainedUsed + fromBurst;
      const throttledUnits = demandUnits - acceptedUnits;

      totalDemanded += demandUnits;
      totalAccepted += acceptedUnits;

      partitions.push({
        index: i,
        demandedUnitsPerSec: demandRate,
        acceptedUnitsPerSec: acceptedUnits / dtSeconds,
        throttledUnitsPerSec: throttledUnits / dtSeconds,
        allowanceUnitsPerSec: allowanceRate,
        burstTokens: bucket.tokens,
        utilization: allowanceRate > 0 ? demandRate / allowanceRate : demandRate > 0 ? Infinity : 0,
      });
    }

    return {
      demandedUnitsPerSec: totalDemanded / dtSeconds,
      acceptedUnitsPerSec: totalAccepted / dtSeconds,
      throttledUnitsPerSec: (totalDemanded - totalAccepted) / dtSeconds,
      partitions,
    };
  }
}
