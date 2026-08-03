import type { Demand } from '../sim/demand.js';
import { SimulationClock, type SimulationClockConfig } from '../sim/simulationClock.js';
import {
  AuroraLiveSession,
  type AuroraLiveSettings,
  type AuroraSessionSnapshot,
} from './aurora/liveSession.js';
import {
  DynamoDbLiveSession,
  type DynamoDbLiveSettings,
  type DynamoDbSessionSnapshot,
} from './dynamodb/liveSession.js';
import {
  SqsLiveSession,
  type SqsLiveSettings,
  type SqsSessionSnapshot,
} from './sqs/liveSession.js';
import type { AuroraWriter } from '../services/aurora/writer.js';
import type { DynamoDbTable } from '../services/dynamodb/table.js';
import type { SqsQueue } from '../services/sqs/queue.js';

export interface TerrariumDriverConfig {
  /** 負荷ダイヤルの初期値。**1 本しかない**。 */
  readonly load: Demand;
  readonly dynamodb: DynamoDbLiveSettings;
  readonly aurora: AuroraLiveSettings;
  readonly sqs: SqsLiveSettings;
  readonly clock?: SimulationClockConfig | undefined;
}

/**
 * driver の外へ見せるセッション。**時間を進める手段をすべて取り除いてある**。
 *
 * 3D は毎フレーム `latest` を直読みする必要があるのでセッション自体は公開せざるを得ないが、
 * `step` に手が届くと `driver.aurora.step(demand, 5)` と書けてしまい、
 * 片方だけ仮想時間が進む — 時計を 1 本にした意味が消える。
 * 型で外しておけば、その 1 行はコンパイルを通らない。
 *
 * ⚠️ セッションから `step` を外すだけでは足りない。セッションは `writer` / `table` という
 * **モデル本体への参照**を 3D のために公開しており、そちらの `step` は素通りするので
 * `driver.aurora.writer.step(demand, 5)` と書けてしまう。
 * 同じ理由で `retryPolicy` の setter も塞ぐ（設定を通さずに writer だけ変えると、
 * `AuroraLiveSettings` と実体が乖離して ControlPanel の表示が嘘になる）。
 * → モデル本体も投影した型で返す。
 */
export type DrivenSession<T> = Omit<T, 'step'>;

/** 3D が読むだけの writer。**駆動する手段も設定を変える手段も含まれていない**。 */
export type ObservedAuroraWriter = Omit<AuroraWriter, 'step' | 'retryPolicy'>;
/** 3D が読むだけのテーブル。 */
export type ObservedDynamoDbTable = Omit<DynamoDbTable, 'step'>;
/**
 * 3D が読むだけのキュー。
 *
 * `consumerCount` / `messageRetentionSeconds` の setter も塞ぐ（`retryPolicy` と同じ理由）。
 * 設定を通さずにキューだけ変えると `SqsLiveSettings` と実体が乖離し、
 * ControlPanel の表示が嘘になる。
 */
export type ObservedSqsQueue = Omit<SqsQueue, 'step' | 'consumerCount' | 'messageRetentionSeconds'> & {
  readonly consumerCount: number;
  readonly messageRetentionSeconds: number;
};

/** View（3D・HUD）が受け取るセッションの型。時間を進める手段は含まれていない。 */
export type DrivenDynamoDbSession = Omit<DrivenSession<DynamoDbLiveSession>, 'table'> & {
  readonly table: ObservedDynamoDbTable;
};
export type DrivenAuroraSession = Omit<DrivenSession<AuroraLiveSession>, 'writer'> & {
  readonly writer: ObservedAuroraWriter;
};
export type DrivenSqsSession = Omit<DrivenSession<SqsLiveSession>, 'queue'> & {
  readonly queue: ObservedSqsQueue;
};

/** 画面 1 枚ぶんの状態を、**同一時刻**で切り出したもの。 */
export interface TerrariumSnapshot {
  /** 画面全体の経過時間 (秒)。全サービスに共通の唯一の時計。 */
  readonly simulatedSeconds: number;
  readonly timeScale: number;
  readonly load: Demand;
  readonly dynamodb: DynamoDbSessionSnapshot;
  readonly aurora: AuroraSessionSnapshot;
  readonly sqs: SqsSessionSnapshot;
}

/**
 * DynamoDB / Aurora / SQS を**同じ時間・同じ負荷**で並べて走らせる駆動体。
 *
 * ## なぜこれが要るのか（M3 / M4 の主題そのもの）
 *
 * 見せたいのは「同じ 500 q/s を、どれも容量 400 q/s のサービスへ流したとき」の差である:
 *
 * | | 受理 | 拒否 | 症状 |
 * |---|---|---|---|
 * | DynamoDB | 400 q/s | 100 q/s | 5 ms 一定 |
 * | Aurora | 400 q/s | 100 q/s | 2,646 ms |
 * | SQS | **500 q/s（全部）** | **0** | 何も起きない。100 件/秒ずつ溜まる |
 *
 * この主張が成り立つのは**全員にまったく同じものを流したときだけ**なので、
 * 「同じものを流している」を規律ではなく**構造**で保証する必要がある。
 *
 * そのために、このクラスが 2 つのものを独占する:
 *
 * ### 1. 時計を 1 本にする
 *
 * 各セッションが `SimulationClock` を持つと時計がサービスの数だけできる。
 * 同じ経過秒を配っている限り結果は一致するが、`timeScale`（早送り）を
 * 片方にだけ適用した瞬間に**静かにズレる**。しかも症状は
 * 「レイテンシの差が縮んで見える」なので、バグではなく発見に見えてしまう。
 *
 * → 時計はここだけが持つ。セッション側は `step(demand, tickSeconds)` しか持たず、
 *   **View から個々のセッションの時計に手が届かない**。
 *
 * ### 2. 負荷ダイヤルを 1 本にする
 *
 * 切り離しトグルは**付けない**。ずらせないことが
 * 「この実験は必ず公平である」を保証しており、これは教材としての正しさの一部である。
 * 各セッションの設定から負荷を外してあるので、片方だけ違う負荷を流す経路は存在しない。
 *
 * ## 一方、束ねないもの
 *
 * 3 つのセッションを共通インターフェースへは押し込めない。
 * 内部モデルが違いすぎる（テーブルの形 / 1 台のインスタンスの諸元 / キューと consumer）ので、
 * 抽象化しても「どれでもない何か」ができるだけになる。
 * ここは 3 つを**具体的なまま持つ**。共有するのは時間と負荷だけでよい。
 *
 * ⚠️ **サービスを足すたびにこのクラスだけが太る**のは意図した設計である。
 * 増えるのは「同じ負荷を配る」「同じ瞬間で切り出す」という 1 行ずつだけで、
 * 各サービスのモデルは互いを一切知らないまま独立していられる。
 */
export class TerrariumDriver {
  readonly #clock: SimulationClock;
  readonly #dynamodb: DynamoDbLiveSession;
  readonly #aurora: AuroraLiveSession;
  readonly #sqs: SqsLiveSession;
  #load: Demand;

  constructor(config: TerrariumDriverConfig) {
    this.#clock = new SimulationClock(config.clock);
    this.#load = validateLoad(config.load);
    this.#dynamodb = new DynamoDbLiveSession(config.dynamodb);
    this.#aurora = new AuroraLiveSession(config.aurora);
    this.#sqs = new SqsLiveSession(config.sqs);
  }

  get dynamodb(): DrivenDynamoDbSession {
    return this.#dynamodb;
  }

  get aurora(): DrivenAuroraSession {
    return this.#aurora;
  }

  get sqs(): DrivenSqsSession {
    return this.#sqs;
  }

  /** 共有の負荷ダイヤルの現在値。 */
  get load(): Demand {
    return this.#load;
  }

  /** 1 tick の仮想時間 (秒)。倍速にしても変わらない。 */
  get tickSeconds(): number {
    return this.#clock.tickSeconds;
  }

  /** 画面全体の経過時間 (秒)。セッションを作り直しても巻き戻らない。 */
  get simulatedSeconds(): number {
    return this.#clock.simulatedSeconds;
  }

  get timeScale(): number {
    return this.#clock.timeScale;
  }

  /**
   * 早送り。**両方に等しく効く**（片方だけに掛ける経路は用意しない）。
   */
  set timeScale(value: number) {
    this.#clock.timeScale = value;
  }

  /** 共有の負荷ダイヤルを回す。次の tick から両サービスに同じ値が流れる。 */
  setLoad(patch: Partial<Demand>): void {
    this.#load = validateLoad({ ...this.#load, ...patch });
  }

  /**
   * フレームの経過秒を渡して、溜まった分だけシミュレーションを進める。
   * tick 幅は常に固定なので、フレームレートが揺れても結果は変わらない。
   *
   * @returns 実際に刻んだ tick 数
   */
  advance(realDeltaSeconds: number): number {
    return this.#clock.advance(realDeltaSeconds, (tickSeconds) => {
      // ⚠️ 同じ `Demand` の参照と同じ tick 幅を全員へ配る。
      // ここで負荷を作り分けたり、1 つだけ 2 回進めたりした瞬間に並置の対比が崩れる。
      this.#dynamodb.step(this.#load, tickSeconds);
      this.#aurora.step(this.#load, tickSeconds);
      this.#sqs.step(this.#load, tickSeconds);
    });
  }

  /**
   * View 向けの状態。**必ず全員を 1 回で取る**。
   *
   * 1 つずつ別のタイミングで読むと、tick をまたいだ数字が並んで
   * 「同じ瞬間の比較」でなくなる。並置の主張はそこが崩れると成立しない。
   */
  snapshot(): TerrariumSnapshot {
    return {
      simulatedSeconds: this.#clock.simulatedSeconds,
      timeScale: this.#clock.timeScale,
      load: this.#load,
      dynamodb: this.#dynamodb.snapshot(),
      aurora: this.#aurora.snapshot(),
      sqs: this.#sqs.snapshot(),
    };
  }
}

/**
 * 負荷の値を検査する。
 *
 * NaN をここで止めるのは Aurora と SQS のためである。どちらも滞留状態が tick をまたぐので、
 * 一度でも NaN が混じると以降どんな正常な入力を流しても復帰しない
 * （SQS はさらに `ArrivalLedger` の折れ線まで壊れ、年齢の逆引きも道連れになる）。
 * 各モデル側にも同じ防御があるが、そちらは黙って 0 に潰す。
 * ダイヤルの入口では**気づける形で失敗させる**ほうがよい。
 */
function validateLoad(load: Demand): Demand {
  requireNonNegative(load.readsPerSecond, 'readsPerSecond');
  requireNonNegative(load.writesPerSecond, 'writesPerSecond');
  // 渡された参照をそのまま抱えない。プリセットの負荷は複数のプリセットで共有された
  // オブジェクトなので、外から書き換えられる経路を残さない。
  return Object.freeze({
    readsPerSecond: load.readsPerSecond,
    writesPerSecond: load.writesPerSecond,
  });
}

function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} は 0 以上の有限数である必要がある: ${value}`);
  }
}
