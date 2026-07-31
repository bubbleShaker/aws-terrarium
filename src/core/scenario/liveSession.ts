import { buildKeyWeights, type KeyDistributionSpec } from '../services/dynamodb/keyDistribution.js';
import {
  type CapacityConfig,
  DynamoDbTable,
  type DynamoDbTickResult,
  type LaneInfo,
  type LaneTickResult,
} from '../services/dynamodb/table.js';
import { SimulationClock, type SimulationClockConfig } from '../sim/simulationClock.js';

/**
 * インタラクティブに動かすときのテーブル設定。
 *
 * `runScenario()` の `Scenario` と分けているのは、用途が違うため:
 * - `Scenario` は「最後まで一気に流して集計する」バッチ用。負荷は時間の関数 (`LoadProfile`)
 * - `LiveSettings` は「人間がダイヤルを回す」用。負荷はその瞬間の値であり、時間の関数ではない
 *
 * 同じ型を無理に共用すると、UI から `LoadProfile` を組み立てる羽目になって歪む。
 */
export interface LiveSettings {
  /** ダイヤルで動かす負荷。ここだけはテーブルを作り直さずに変えられる。 */
  readonly readsPerSecond: number;
  readonly writesPerSecond: number;
  readonly distribution: KeyDistributionSpec;
  readonly keyCount: number;
  readonly capacity: CapacityConfig;
  readonly tableSizeGb: number;
  readonly itemSizeKb: number;
  readonly consistentRead: boolean;
  readonly initialBurstTokens?: number | undefined;
}

export type LaneKind = 'read' | 'write';

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

export interface SessionSnapshot {
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
 */
export class LiveSession {
  #settings: LiveSettings;
  #table: DynamoDbTable;
  #shapeKey: string;
  #clock: SimulationClock;
  #latest: DynamoDbTickResult | undefined;
  #generation = 0;

  constructor(settings: LiveSettings, clockConfig?: SimulationClockConfig) {
    this.#settings = settings;
    this.#shapeKey = tableShapeKey(settings);
    this.#table = buildTable(settings);
    this.#clock = new SimulationClock(clockConfig);
  }

  get settings(): LiveSettings {
    return this.#settings;
  }

  get table(): DynamoDbTable {
    return this.#table;
  }

  get clock(): SimulationClock {
    return this.#clock;
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
  update(patch: Partial<LiveSettings>): boolean {
    const next: LiveSettings = { ...this.#settings, ...patch };
    const nextShapeKey = tableShapeKey(next);
    this.#settings = next;

    if (nextShapeKey === this.#shapeKey) return false;

    this.#shapeKey = nextShapeKey;
    this.#table = buildTable(next);
    this.#latest = undefined;
    this.#generation += 1;
    this.#clock.reset();
    return true;
  }

  /** 設定をまるごと差し替える。プリセットの読み込み用。 */
  replace(settings: LiveSettings): boolean {
    return this.update(settings);
  }

  /**
   * フレームの経過秒を渡して、溜まった分だけシミュレーションを進める。
   * tick 幅は常に固定なので、フレームレートが揺れても結果は変わらない。
   *
   * @returns 実際に刻んだ tick 数
   */
  advance(realDeltaSeconds: number): number {
    return this.#clock.advance(realDeltaSeconds, (tickSeconds) => {
      this.#latest = this.#table.step(
        {
          readsPerSecond: this.#settings.readsPerSecond,
          writesPerSecond: this.#settings.writesPerSecond,
        },
        tickSeconds,
      );
    });
  }

  /**
   * View 向けの読みやすい形に変換した現在の状態。
   *
   * 毎フレームではなく HUD の更新頻度 (10Hz 程度) で呼ぶことを想定している。
   * 毎フレーム必要な値は `latest` から直接読むこと。
   */
  snapshot(): SessionSnapshot {
    const { read, write } = this.#table.lanes;
    return {
      simulatedSeconds: this.#clock.simulatedSeconds,
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
        burstRatio: info.burstCapacityUnits > 0 ? p.burstTokens / info.burstCapacityUnits : 0,
        burstDrawUnitsPerSec: p.burstDrawUnitsPerSec,
        throttleRate: p.demandedUnitsPerSec > 0 ? p.throttledUnitsPerSec / p.demandedUnitsPerSec : 0,
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

function buildTable(settings: LiveSettings): DynamoDbTable {
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
 * 負荷 (rps) だけを取り除いた残り全部を鍵にしている。
 * 個別に列挙すると、あとで設定項目を足したときに**ここへの追加を忘れて**
 * 「変えたのに反映されない」という気づきにくいバグを生む。
 * 残り全部にしておけば、忘れたときの挙動は「余計に作り直す」（安全側）に倒れる。
 */
function tableShapeKey(settings: LiveSettings): string {
  const { readsPerSecond: _reads, writesPerSecond: _writes, ...shape } = settings;
  return stableStringify(shape);
}

/**
 * キーの順序に依存しない JSON 文字列化。
 * 素の `JSON.stringify` はプロパティの定義順で結果が変わるため、
 * 同じ内容の設定でもオブジェクトの組み立て方が違うと別物と判定されてしまう。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
