import { maxMinFairShare } from './fairShare.js';

/**
 * テーブルのキャパシティを各パーティションへどう配るかの戦略。
 *
 * 配分方針こそがこのモデルで差し替えたい軸なので、boolean フラグで分岐させず
 * インターフェースとして切り出す。将来 on-demand のプリウォーム挙動などを足すときに、
 * 消費側 (`CapacityLane`) を一切触らずに済む。
 */
export interface CapacityAllocator {
  readonly name: string;
  /** 各パーティションが使える持続レート (units/秒) を返す。 */
  allocate(demandPerPartition: readonly number[]): number[];
}

export interface AllocatorContext {
  readonly partitionCount: number;
  /** テーブル全体で使えるキャパシティ (units/秒)。 */
  readonly tableCapacityPerSec: number;
  /** 1 パーティションの物理上限 (units/秒)。3,000 (read) または 1,000 (write)。 */
  readonly perPartitionMaxPerSec: number;
}

/**
 * 頭割りしたときの 1 パーティションあたりの取り分 (units/秒)。
 *
 * この値は 2 つの意味を持つ:
 *   1. アダプティブ無しのときの持続レートそのもの
 *   2. **バーストの貯金が貯まる基準**（アダプティブの有無に関わらず「払っている分」）
 *
 * 複数箇所で同じ式を書くと片方だけ直して静かに矛盾するので、必ずここを通す。
 */
export function evenShareRatePerSec(context: AllocatorContext): number {
  return Math.min(
    context.tableCapacityPerSec / context.partitionCount,
    context.perPartitionMaxPerSec,
  );
}

/**
 * アダプティブキャパシティ無し。需要に関係なく頭割りする。
 * 暇なパーティションが枠を握ったまま離さないので、偏りがあると必ず溢れる。
 */
export class EvenSplitAllocator implements CapacityAllocator {
  readonly name = 'even-split';
  readonly #ratePerSec: number;
  readonly #partitionCount: number;

  constructor(context: AllocatorContext) {
    this.#ratePerSec = evenShareRatePerSec(context);
    this.#partitionCount = context.partitionCount;
  }

  /** 需要は見ない。それがこの戦略の定義そのもの。 */
  allocate(_demandPerPartition?: readonly number[]): number[] {
    return new Array<number>(this.#partitionCount).fill(this.#ratePerSec);
  }
}

/**
 * アダプティブキャパシティ。需要のある所へ余剰を回す。
 *
 * ただし**パーティションの物理上限は絶対に超えられない**。
 * 救えるのは「テーブル全体には余裕があるのに頭割りのせいで足りない」ケースだけで、
 * 単一ホットキーのように上限そのものに当たっている場合は打つ手がない。
 */
export class AdaptiveAllocator implements CapacityAllocator {
  readonly name = 'adaptive';
  readonly #context: AllocatorContext;

  constructor(context: AllocatorContext) {
    this.#context = context;
  }

  allocate(demandPerPartition: readonly number[]): number[] {
    // 需要を超えて配っても無駄なので、需要とパーティション上限の小さい方で頭を打たせ、
    // 余った分を他へ回す。
    const ceilings = demandPerPartition.map((demand) =>
      Math.min(Math.max(demand, 0), this.#context.perPartitionMaxPerSec),
    );
    return maxMinFairShare(ceilings, this.#context.tableCapacityPerSec);
  }
}

export function createAllocator(context: AllocatorContext, adaptive: boolean): CapacityAllocator {
  return adaptive ? new AdaptiveAllocator(context) : new EvenSplitAllocator(context);
}
