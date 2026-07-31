import { TokenBucket } from '../../sim/tokenBucket.js';
import { type AllocatorContext, type CapacityAllocator, evenShareRatePerSec } from './allocator.js';
import { BURST_WINDOW_SECONDS } from './limits.js';

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
  /** この tick に配分された持続レート (units/秒) */
  readonly allowanceUnitsPerSec: number;
  /** バーストの残り貯金 (units) */
  readonly burstTokens: number;
  /** バーストから持ち出した量 (units/秒)。0 より大きければ貯金を食っている。 */
  readonly burstDrawUnitsPerSec: number;
  /**
   * 需要 / 頭割りの取り分。1 を超えたら「自分の取り分より多く要求している」。
   * 分母をアダプティブの配分ではなく頭割りに固定しているのは、
   * モードによって指標の意味が変わらないようにするため。
   */
  readonly utilizationVsBaseline: number;
  /**
   * 需要 / パーティション物理上限。1 に達したらもう打つ手がない。
   * アダプティブでもプロビジョニング増でも越えられない壁との距離を表す。
   */
  readonly utilizationVsHardCap: number;
}

export interface LaneStepResult {
  readonly demandedUnitsPerSec: number;
  readonly acceptedUnitsPerSec: number;
  readonly throttledUnitsPerSec: number;
  readonly partitions: readonly PartitionLaneResult[];
}

export interface CapacityLaneConfig extends AllocatorContext {
  readonly allocator: CapacityAllocator;
  /**
   * バーストの初期貯金 (units)。既定は満タン。
   *
   * 満タン開始は「シミュレーション開始前、テーブルは 300 秒以上暇だった」という想定。
   * スパイクの吸収を観測したいなら満タン、定常状態だけ見たいなら 0 を指定する。
   */
  readonly initialBurstTokens?: number | undefined;
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
    this.#baselineRatePerSec = evenShareRatePerSec(config);

    // 貯金の枠も貯まる速度も「払っている分」= 頭割りの取り分から決まる。
    // アダプティブで一時的に配分が増えても、貯金が増えるわけではない。
    const burstCapacity = this.#baselineRatePerSec * BURST_WINDOW_SECONDS;
    const initialTokens = config.initialBurstTokens ?? burstCapacity;
    this.#buckets = Array.from(
      { length: config.partitionCount },
      () => new TokenBucket(burstCapacity, initialTokens),
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

    const allowance = this.#config.allocator.allocate(demandPerPartition);
    const { perPartitionMaxPerSec, partitionCount } = this.#config;

    const partitions: PartitionLaneResult[] = [];
    let totalDemanded = 0;
    let totalAccepted = 0;

    for (let i = 0; i < partitionCount; i += 1) {
      const bucket = this.#buckets[i];
      if (bucket === undefined) {
        // 構築時に partitionCount 本作っているので到達しない。
        // 黙って continue すると集計から静かに消えて合計値が壊れるため、明示的に落とす。
        throw new Error(`パーティション ${i} のバケットが存在しない`);
      }

      const demandRate = Math.max(0, demandPerPartition[i] ?? 0);
      const allowanceRate = Math.max(0, allowance[i] ?? 0);

      const demandUnits = demandRate * dtSeconds;
      // バーストの貯金を使っても、パーティションの物理上限は絶対に超えられない。
      // 「バーストがあるから 1,000 WCU の壁を越えられる」わけではない、という肝。
      const hardCapUnits = perPartitionMaxPerSec * dtSeconds;
      const allowedUnits = Math.min(demandUnits, hardCapUnits);

      // 1. まず配分された持続レートの範囲で通す。
      const sustainedUnits = allowanceRate * dtSeconds;
      const capacityUsed = Math.min(allowedUnits, sustainedUnits);

      // 2. 「払っている分」を使い切らなかった差額が貯金になる。
      //    アダプティブで配分が増えていても、貯金の基準は頭割りのまま。
      //    ここを配分基準にすると、アダプティブ時は allowance <= demand が常に成り立つため
      //    差額が恒久的に 0 になり、貯金が二度と回復しなくなる。
      const baselineUnits = this.#baselineRatePerSec * dtSeconds;
      bucket.refill(Math.max(0, baselineUnits - capacityUsed));

      // 3. 足りない分を貯金から持ち出す。
      const fromBurst = bucket.consume(allowedUnits - capacityUsed);

      const acceptedUnits = capacityUsed + fromBurst;
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
        burstDrawUnitsPerSec: fromBurst / dtSeconds,
        utilizationVsBaseline: ratio(demandRate, this.#baselineRatePerSec),
        utilizationVsHardCap: ratio(demandRate, perPartitionMaxPerSec),
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

function ratio(numerator: number, denominator: number): number {
  if (denominator > 0) return numerator / denominator;
  return numerator > 0 ? Infinity : 0;
}
