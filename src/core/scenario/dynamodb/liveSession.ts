import { buildKeyWeights, type KeyDistributionSpec } from '../../services/dynamodb/keyDistribution.js';
import {
  partitionBurstRatio,
  partitionThrottleRate,
} from '../../services/dynamodb/partitionMetrics.js';
import {
  type CapacityConfig,
  DynamoDbTable,
  type DynamoDbTickResult,
  type LaneInfo,
  type LaneTickResult,
} from '../../services/dynamodb/table.js';
import type { Demand, LaneKind } from '../../sim/demand.js';
import { stableStringify } from '../shapeKey.js';

/**
 * インタラクティブに動かすときのテーブル設定。
 *
 * `runScenario()` の `Scenario` と分けているのは、用途が違うため:
 * - `Scenario` は「最後まで一気に流して集計する」バッチ用。負荷は時間の関数 (`LoadProfile`)
 * - `DynamoDbLiveSettings` は「人間がダイヤルを回す」用
 *
 * 同じ型を無理に共用すると、UI から `LoadProfile` を組み立てる羽目になって歪む。
 *
 * ⚠️ **負荷 (rps) はここに無い**。M3 で負荷ダイヤルを 1 本の共有にしたため、
 * 負荷は `TerrariumDriver` が持ち、`step()` の引数として毎 tick 渡ってくる。
 * ここに残すと DynamoDB 側と Aurora 側で 2 つの負荷が並立し、
 * 「同じ負荷を両方へ流している」がコードの構造ではなく運用の約束事に落ちる。
 */
export interface DynamoDbLiveSettings {
  readonly distribution: KeyDistributionSpec;
  readonly keyCount: number;
  readonly capacity: CapacityConfig;
  readonly tableSizeGb: number;
  readonly itemSizeKb: number;
  readonly consistentRead: boolean;
  readonly initialBurstTokens?: number | undefined;
}

/** 柱 1 本を描くのに必要な値を 1 つにまとめたもの。 */
export interface PartitionView {
  readonly index: number;
  /** このパーティションが受け持つトラフィックの割合 (0..1)。 */
  readonly weight: number;
  readonly demandedUnitsPerSec: number;
  readonly acceptedUnitsPerSec: number;
  readonly throttledUnitsPerSec: number;
  /** 需要 / 物理上限。**赤熱の指標はこれ**。1 に達したら打つ手がない。 */
  readonly utilizationVsHardCap: number;
  /** 需要 / 頭割りの取り分。1 を超えたら自分の取り分より多く要求している。 */
  readonly utilizationVsBaseline: number;
  /** バーストの残量 (0..1)。1 = 満タン。急に壊れる理由がこれで見える。 */
  readonly burstRatio: number;
  /** この tick で貯金から持ち出している量 (units/秒)。 */
  readonly burstDrawUnitsPerSec: number;
  /** このパーティション単体のスロットル率 (0..1)。 */
  readonly throttleRate: number;
}

export interface LaneView {
  readonly kind: LaneKind;
  readonly demandedRequestsPerSec: number;
  readonly acceptedRequestsPerSec: number;
  readonly throttledRequestsPerSec: number;
  /** テーブル全体のスロットル率。**これがホットパーティションを隠す**。 */
  readonly throttleRate: number;
  readonly info: LaneInfo;
  readonly partitions: readonly PartitionView[];
  /** 最も需要が集中しているパーティション。全体の数字が隠すものを名指しするため。 */
  readonly hottest: PartitionView | undefined;
}

export interface DynamoDbSessionSnapshot {
  /** 刻んだ仮想時間の合計 (秒)。 */
  readonly simulatedSeconds: number;
  readonly partitionCount: number;
  /** 均等に散った場合の 1 パーティションあたりの割合。比較の基準線。 */
  readonly idealShare: number;
  /** 実効のアダプティブキャパシティ。on-demand では設定に関わらず true。 */
  readonly adaptiveCapacity: boolean;
  /** テーブルを作り直した回数。View が粒子を作り直す判断に使う。 */
  readonly generation: number;
  readonly read: LaneView;
  readonly write: LaneView;
}

/**
 * ダイヤルを回しながら動かし続けるセッション。
 *
 * ## このクラスが引き受けている判断
 *
 * `DynamoDbTable` は設定不変である。コンストラクタでパーティション数もキーの割り当ても
 * 確定するため、キー分布やキャパシティを変えるには**作り直すしかない**。
 * 一方、負荷 (rps) は毎 tick 渡すだけなので作り直し不要。
 *
 * この「作り直す / 作り直さない」の境界を View に散らすと必ず壊れるので、
 * ここに閉じ込める。View は「設定を渡す」「最新の状態を読む」の 2 つだけを知ればよい。
 *
 * 作り直すとバーストの貯金も経過時間もリセットされる。これは仕様である
 * （設定を変えた瞬間から新しいテーブルが始まる、という素直な解釈）。
 * `generation` が増えるので、View 側はそれを見てリセットに追随できる。
 *
 * ## 時計は持たない（M3 で変えた点）
 *
 * 以前はこのクラスが `SimulationClock` を持ち `advance(realDeltaSeconds)` を提供していた。
 * Aurora を並置すると時計が 2 つになり、`timeScale`（早送り）を片方にだけ掛けた瞬間に
 * **両者の仮想時間が静かにズレる**。「同じ負荷を同じ時間だけ流す」が崩れると M3 の対比は成立しない。
 * そこで時計は `TerrariumDriver` に一本化し、ここは
 * **渡された tick 幅ぶんだけ進む純粋な被駆動体**になった。
 */
export class DynamoDbLiveSession {
  #settings: DynamoDbLiveSettings;
  #table: DynamoDbTable;
  #shapeKey: string;
  #latest: DynamoDbTickResult | undefined;
  #generation = 0;
  /**
   * このテーブルが生きている間に刻んだ仮想時間 (秒)。作り直すと 0 に戻る。
   *
   * driver 側の `simulatedSeconds`（画面全体の経過時間）とは意味が違う。
   * こちらは「今のテーブルが何秒動いたか」で、バーストの貯金の減り具合と対応する。
   */
  #simulatedSeconds = 0;

  constructor(settings: DynamoDbLiveSettings) {
    this.#settings = settings;
    this.#shapeKey = tableShapeKey(settings);
    this.#table = buildTable(settings);
  }

  get settings(): DynamoDbLiveSettings {
    return this.#settings;
  }

  get table(): DynamoDbTable {
    return this.#table;
  }

  /** 直近の tick 結果。まだ 1 度も進んでいなければ undefined。 */
  get latest(): DynamoDbTickResult | undefined {
    return this.#latest;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * 設定を差し替える。テーブルの形が変わる項目が含まれていれば作り直す。
   *
   * @returns 作り直したかどうか
   */
  update(patch: Partial<DynamoDbLiveSettings>): boolean {
    return this.#apply({ ...this.#settings, ...patch });
  }

  /**
   * 設定を**まるごと**差し替える。プリセットの読み込み用。
   *
   * `update()` に委譲してはいけない。あちらはマージなので、
   * 省略可能なフィールド (`initialBurstTokens`) が前の設定から残留する。
   * 「`big-item-trap` を見たあとに他のプリセットを選ぶと、
   * バーストの貯金が 0 のまま始まる」という形で教材が壊れる。
   */
  replace(settings: DynamoDbLiveSettings): boolean {
    return this.#apply(settings);
  }

  #apply(next: DynamoDbLiveSettings): boolean {
    const nextShapeKey = tableShapeKey(next);
    if (nextShapeKey === this.#shapeKey) {
      // 内容が同じなら何もしない。同じ設定を渡し直しただけでリセットされると、
      // プリセットを押し直すたびに時間が巻き戻る。
      this.#settings = next;
      return false;
    }

    // 先に作ってから差し替える。設定が不正で例外が飛んだとき、
    // 「鍵は新しいのにテーブルは古い」状態で固定されると二度と再構築されなくなる。
    const table = buildTable(next);

    this.#settings = next;
    this.#shapeKey = nextShapeKey;
    this.#table = table;
    this.#latest = undefined;
    this.#generation += 1;
    this.#simulatedSeconds = 0;
    return true;
  }

  /**
   * 1 tick 進める。**呼ぶのは `TerrariumDriver` だけ**。
   *
   * 実時間 (フレームの経過秒) をここへ渡してはいけない。固定タイムステップへの
   * 変換は駆動側の `SimulationClock` が済ませており、ここに来る `tickSeconds` は常に一定である。
   */
  step(demand: Demand, tickSeconds: number): void {
    this.#latest = this.#table.step(demand, tickSeconds);
    this.#simulatedSeconds += tickSeconds;
  }

  /**
   * View 向けの読みやすい形に変換した現在の状態。
   *
   * 毎フレームではなく HUD の更新頻度 (10Hz 程度) で呼ぶことを想定している。
   * 毎フレーム必要な値は `latest` から直接読むこと。
   */
  snapshot(): DynamoDbSessionSnapshot {
    const { read, write } = this.#table.lanes;
    return {
      simulatedSeconds: this.#simulatedSeconds,
      partitionCount: this.#table.partitionCount,
      idealShare: 1 / this.#table.partitionCount,
      adaptiveCapacity: this.#table.adaptiveCapacity,
      generation: this.#generation,
      read: this.#laneView('read', this.#latest?.read, read),
      write: this.#laneView('write', this.#latest?.write, write),
    };
  }

  #laneView(kind: LaneKind, lane: LaneTickResult | undefined, info: LaneInfo): LaneView {
    const weights = this.#table.partitionWeights;
    const partitions: PartitionView[] = weights.map((weight, index) => {
      const p = lane?.partitions[index];
      if (p === undefined) {
        // まだ 1 度も進んでいない状態。0 で埋めて View の分岐を減らす。
        return {
          index,
          weight,
          demandedUnitsPerSec: 0,
          acceptedUnitsPerSec: 0,
          throttledUnitsPerSec: 0,
          utilizationVsHardCap: 0,
          utilizationVsBaseline: 0,
          burstRatio: 1,
          burstDrawUnitsPerSec: 0,
          throttleRate: 0,
        };
      }
      return {
        index,
        weight,
        demandedUnitsPerSec: p.demandedUnitsPerSec,
        acceptedUnitsPerSec: p.acceptedUnitsPerSec,
        throttledUnitsPerSec: p.throttledUnitsPerSec,
        utilizationVsHardCap: p.utilizationVsHardCap,
        utilizationVsBaseline: p.utilizationVsBaseline,
        burstRatio: partitionBurstRatio(p, info),
        burstDrawUnitsPerSec: p.burstDrawUnitsPerSec,
        throttleRate: partitionThrottleRate(p),
      };
    });

    const hottest = partitions.reduce<PartitionView | undefined>(
      (best, current) =>
        best === undefined || current.demandedUnitsPerSec > best.demandedUnitsPerSec ? current : best,
      undefined,
    );

    return {
      kind,
      demandedRequestsPerSec: lane?.demandedRequestsPerSec ?? 0,
      acceptedRequestsPerSec: lane?.acceptedRequestsPerSec ?? 0,
      throttledRequestsPerSec: lane?.throttledRequestsPerSec ?? 0,
      throttleRate: lane?.throttleRate ?? 0,
      info,
      partitions,
      hottest,
    };
  }
}

function buildTable(settings: DynamoDbLiveSettings): DynamoDbTable {
  return new DynamoDbTable({
    capacity: settings.capacity,
    tableSizeGb: settings.tableSizeGb,
    itemSizeKb: settings.itemSizeKb,
    consistentRead: settings.consistentRead,
    keyWeights: buildKeyWeights(settings.distribution, settings.keyCount),
    initialBurstTokens: settings.initialBurstTokens,
  });
}

/**
 * テーブルの「形」を表す文字列。これが変わったら作り直す必要がある。
 *
 * M3 で負荷が設定から外れたので、いまや `DynamoDbLiveSettings` の項目はすべて形である
 * （＝ダイヤルを回してもテーブルは作り直されない、という以前の性質は driver 側が担う）。
 * 除外する項目が 1 つも無いので設定を丸ごと鍵にできる。方針は `shapeKey.ts` を参照。
 */
function tableShapeKey(settings: DynamoDbLiveSettings): string {
  return stableStringify(settings);
}
