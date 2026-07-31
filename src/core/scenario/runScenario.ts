import type { LoadProfile } from '../sim/loadProfile.js';
import { DynamoDbTable, type DynamoDbTableConfig, type DynamoDbTickResult } from '../services/dynamodb/table.js';

export interface Scenario {
  readonly name: string;
  /** このシナリオで何を体感してほしいかの 1 行。UI にそのまま出す。 */
  readonly lesson: string;
  readonly table: DynamoDbTableConfig;
  readonly load: LoadProfile;
  readonly durationSeconds: number;
  /** 1 tick の仮想時間 (秒)。既定 0.1 秒。 */
  readonly tickSeconds?: number;
  /**
   * 履歴として保持する tick の最大数。既定 2,000。
   *
   * 全 tick を保持すると 900 秒 × 0.1 秒 tick × 50 パーティション で 100MB 超のヒープを食う。
   * M2 でブラウザに載せる前提なので、既定で間引く。
   * 集計 (`summary`) は間引きに関わらず**全 tick** から計算するので、統計値は正確なまま。
   */
  readonly maxRecordedTicks?: number;
}

/** パーティション 1 本の累計。 */
export interface PartitionSummary {
  readonly index: number;
  /** 全トラフィックのうちこのパーティションが受け持つ割合 (0..1)。 */
  readonly trafficShare: number;
  readonly demandedUnits: number;
  readonly acceptedUnits: number;
  readonly throttledUnits: number;
  /** このパーティション**単体**のスロットル率 (0..1)。 */
  readonly throttleRate: number;
}

export interface LaneSummary {
  /** シミュレーション全体での累計リクエスト数 */
  readonly demandedRequests: number;
  readonly acceptedRequests: number;
  readonly throttledRequests: number;
  /** テーブル全体のスロットル率 (0..1)。 */
  readonly throttleRate: number;
  readonly partitions: readonly PartitionSummary[];
  /**
   * 最も需要が集中したパーティション。
   *
   * これを別途持つ理由: **テーブル全体のスロットル率はホットパーティションを隠す**。
   * 50 本中 1 本が全滅していても、全体で見れば数 % にしか見えない。
   * しかしそのキーを使っているユーザーにとっては、リクエストの大半が失敗している。
   * CloudWatch の集計値だけ見ていて障害に気づけない、という実務の事故がまさにこれ。
   */
  readonly hottest: PartitionSummary | undefined;
}

export interface ScenarioSummary {
  readonly partitionCount: number;
  /** 均等に散った場合の 1 パーティションあたりの割合。比較の基準線。 */
  readonly idealShare: number;
  readonly read: LaneSummary;
  readonly write: LaneSummary;
}

export interface ScenarioResult {
  readonly scenario: Scenario;
  /** 間引かれた tick 履歴。`maxRecordedTicks` を超える場合は等間隔にサンプリングされる。 */
  readonly ticks: readonly DynamoDbTickResult[];
  /** 履歴を何 tick おきに保持したか。1 なら間引きなし。 */
  readonly tickSamplingInterval: number;
  readonly summary: ScenarioSummary;
}

export const DEFAULT_TICK_SECONDS = 0.1;
export const DEFAULT_MAX_RECORDED_TICKS = 2_000;

/**
 * シナリオを最後まで走らせる。
 *
 * 固定タイムステップで進める。リクエスト 1 個 = イベント 1 個の古典的な
 * 離散イベントシミュレーションにしないのは、10 万 req/s を扱うと
 * 1 秒ぶんに 10 万イベント必要になって破綻するため。
 * 統計的に計算し、3D 側では粒子をサンプリングして見せる方針を採っている。
 */
export function runScenario(scenario: Scenario): ScenarioResult {
  const tickSeconds = scenario.tickSeconds ?? DEFAULT_TICK_SECONDS;
  if (tickSeconds <= 0) {
    throw new RangeError(`tickSeconds は正の数である必要がある: ${tickSeconds}`);
  }
  if (scenario.durationSeconds <= 0) {
    throw new RangeError(`durationSeconds は正の数である必要がある: ${scenario.durationSeconds}`);
  }

  const maxRecordedTicks = scenario.maxRecordedTicks ?? DEFAULT_MAX_RECORDED_TICKS;
  if (maxRecordedTicks < 1) {
    throw new RangeError(`maxRecordedTicks は 1 以上である必要がある: ${maxRecordedTicks}`);
  }

  const table = new DynamoDbTable(scenario.table);
  const ticks: DynamoDbTickResult[] = [];
  const tickCount = Math.ceil(scenario.durationSeconds / tickSeconds);
  const samplingInterval = Math.max(1, Math.ceil(tickCount / maxRecordedTicks));

  const readAccumulator = new LaneAccumulator(table.partitionCount, table.readUnitsPerRequest);
  const writeAccumulator = new LaneAccumulator(table.partitionCount, table.writeUnitsPerRequest);

  for (let i = 0; i < tickCount; i += 1) {
    // 需要は tick の中点で評価する。開始時刻で評価すると
    // ramp のような単調増加の負荷を半 tick ぶん系統的に過小評価してしまう。
    const demand = scenario.load((i + 0.5) * tickSeconds);
    const tick = table.step(demand, tickSeconds);

    // 集計は全 tick から取る。間引くのは履歴だけ。
    readAccumulator.add(tick.read.partitions, tickSeconds);
    writeAccumulator.add(tick.write.partitions, tickSeconds);

    if (i % samplingInterval === 0) ticks.push(tick);
  }

  return {
    scenario,
    ticks,
    tickSamplingInterval: samplingInterval,
    summary: {
      partitionCount: table.partitionCount,
      idealShare: 1 / table.partitionCount,
      read: readAccumulator.toSummary(),
      write: writeAccumulator.toSummary(),
    },
  };
}

/**
 * 1 レーンぶんの累計を貯める。
 *
 * 各 tick が返すのは「秒あたりのレート」なので、tick 幅を掛けて積分し累計量にする。
 */
class LaneAccumulator {
  readonly #demandedUnits: number[];
  readonly #acceptedUnits: number[];
  readonly #unitsPerRequest: number;

  constructor(partitionCount: number, unitsPerRequest: number) {
    this.#demandedUnits = new Array<number>(partitionCount).fill(0);
    this.#acceptedUnits = new Array<number>(partitionCount).fill(0);
    this.#unitsPerRequest = unitsPerRequest;
  }

  add(
    partitions: readonly { index: number; demandedUnitsPerSec: number; acceptedUnitsPerSec: number }[],
    dtSeconds: number,
  ): void {
    for (const partition of partitions) {
      const i = partition.index;
      const demanded = this.#demandedUnits[i];
      const accepted = this.#acceptedUnits[i];
      if (demanded === undefined || accepted === undefined) continue;
      this.#demandedUnits[i] = demanded + partition.demandedUnitsPerSec * dtSeconds;
      this.#acceptedUnits[i] = accepted + partition.acceptedUnitsPerSec * dtSeconds;
    }
  }

  toSummary(): LaneSummary {
    const totalDemanded = this.#demandedUnits.reduce((sum, v) => sum + v, 0);
    const totalAccepted = this.#acceptedUnits.reduce((sum, v) => sum + v, 0);

    const partitions: PartitionSummary[] = this.#demandedUnits.map((demanded, index) => {
      const accepted = this.#acceptedUnits[index] ?? 0;
      const throttled = Math.max(0, demanded - accepted);
      return {
        index,
        trafficShare: totalDemanded > 0 ? demanded / totalDemanded : 0,
        demandedUnits: demanded,
        acceptedUnits: accepted,
        throttledUnits: throttled,
        throttleRate: demanded > 0 ? throttled / demanded : 0,
      };
    });

    const hottest = partitions.reduce<PartitionSummary | undefined>(
      (best, current) => (best === undefined || current.demandedUnits > best.demandedUnits ? current : best),
      undefined,
    );

    const demandedRequests = totalDemanded / this.#unitsPerRequest;
    const acceptedRequests = totalAccepted / this.#unitsPerRequest;
    const throttledRequests = Math.max(0, demandedRequests - acceptedRequests);

    return {
      demandedRequests,
      acceptedRequests,
      throttledRequests,
      throttleRate: demandedRequests > 0 ? throttledRequests / demandedRequests : 0,
      partitions,
      hottest,
    };
  }
}
