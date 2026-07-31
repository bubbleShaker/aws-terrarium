import { TokenBucket } from '../../sim/tokenBucket.js';
import {
  type AllocatorContext,
  type CapacityAllocator,
  type CapacityAllocatorFactory,
  evenShareRatePerSec,
} from './allocator.js';
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
  /**
   * 配分戦略の生成関数。組み立て済みの allocator ではなく生成関数を受け取るのは、
   * **別の context から作った allocator を渡せてしまう**のを構造的に防ぐため。
   * それを許すと、頭割りの取り分と実際の配分が食い違った状態を作れてしまう。
   */
  readonly allocatorFactory: CapacityAllocatorFactory;
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
  readonly #allocator: CapacityAllocator;
  readonly #buckets: readonly TokenBucket[];
  /** 頭割りしたときの 1 パーティションあたりの取り分 (units/秒)。 */
  readonly #baselineRatePerSec: number;

  constructor(config: CapacityLaneConfig) {
    if (config.partitionCount < 1) {
      throw new RangeError(`partitionCount は 1 以上である必要がある: ${config.partitionCount}`);
    }
    this.#config = config;
    // 自分の context から作るので、配分と頭割りの取り分が必ず同じ前提を共有する。
    this.#allocator = config.allocatorFactory(config);
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

    const allowance = this.#allocator.allocate(demandPerPartition);
    const { perPartitionMaxPerSec, partitionCount } = this.#config;
    const baselineUnits = this.#baselineRatePerSec * dtSeconds;
    // バーストの貯金を使っても、パーティションの物理上限は絶対に超えられない。
    // 「バーストがあるから 1,000 WCU の壁を越えられる」わけではない、という肝。
    const hardCapUnits = perPartitionMaxPerSec * dtSeconds;

    // ── 第 1 段: 各パーティションが持続レートの範囲で通す量を確定する ──
    const plans = Array.from({ length: partitionCount }, (_, i) => {
      const demandRate = Math.max(0, demandPerPartition[i] ?? 0);
      const allowanceRate = Math.max(0, allowance[i] ?? 0);
      const demandUnits = demandRate * dtSeconds;
      const allowedUnits = Math.min(demandUnits, hardCapUnits);
      const sustainedUnits = allowanceRate * dtSeconds;
      return {
        demandRate,
        allowanceRate,
        demandUnits,
        allowedUnits,
        capacityUsed: Math.min(allowedUnits, sustainedUnits),
      };
    });

    // ── 第 2 段: 貯金に回せる量を、テーブル全体で保存則が成り立つように按分する ──
    //
    // 「払っている分 (頭割り) を使い切らなかった差額」が貯金になるのが基本。
    // ただしアダプティブでは、その差額の一部が**他のパーティションへ再配分されて既に使われている**。
    // 単純に差額をそのまま貯金にすると、同じ未使用容量を「再配分」と「貯金」で二重に使うことになり、
    // テーブルのプロビジョニング値を大きく超える量を長時間出せてしまう。
    // そこで、譲った側からは譲った分を差し引く。
    let totalSurplus = 0;
    let totalDonated = 0;
    for (const plan of plans) {
      totalSurplus += Math.max(0, baselineUnits - plan.capacityUsed);
      totalDonated += Math.max(0, plan.capacityUsed - baselineUnits);
    }
    // 余剰のうち、他所へ渡らずに手元に残る割合。
    const retainedRatio = totalSurplus > 0 ? Math.max(0, 1 - totalDonated / totalSurplus) : 0;

    // ── 第 3 段: 貯金を補充し、足りない分を貯金から持ち出す ──
    const partitions: PartitionLaneResult[] = [];
    let totalDemanded = 0;
    let totalAccepted = 0;

    for (let i = 0; i < partitionCount; i += 1) {
      const bucket = this.#buckets[i];
      const plan = plans[i];
      if (bucket === undefined || plan === undefined) {
        // 構築時に partitionCount 本作っているので到達しない。
        // 黙って continue すると集計から静かに消えて合計値が壊れるため、明示的に落とす。
        throw new Error(`パーティション ${i} のバケットが存在しない`);
      }

      const surplus = Math.max(0, baselineUnits - plan.capacityUsed);
      bucket.refill(surplus * retainedRatio);

      const fromBurst = bucket.consume(plan.allowedUnits - plan.capacityUsed);
      const acceptedUnits = plan.capacityUsed + fromBurst;
      const throttledUnits = plan.demandUnits - acceptedUnits;

      totalDemanded += plan.demandUnits;
      totalAccepted += acceptedUnits;

      partitions.push({
        index: i,
        demandedUnitsPerSec: plan.demandRate,
        acceptedUnitsPerSec: acceptedUnits / dtSeconds,
        throttledUnitsPerSec: throttledUnits / dtSeconds,
        allowanceUnitsPerSec: plan.allowanceRate,
        burstTokens: bucket.tokens,
        burstDrawUnitsPerSec: fromBurst / dtSeconds,
        utilizationVsBaseline: ratio(plan.demandRate, this.#baselineRatePerSec),
        utilizationVsHardCap: ratio(plan.demandRate, perPartitionMaxPerSec),
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
