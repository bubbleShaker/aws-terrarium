import type { Demand } from '../../sim/demand.js';
import { ArrivalLedger } from './arrivalLedger.js';
import {
  SQS_DEFAULT_PROCESSING_TIME_MS,
  SQS_DEFAULT_RETENTION_SECONDS,
  SQS_DEFAULT_SEND_LATENCY_MS,
  SQS_MAX_IN_FLIGHT_MESSAGES,
  SQS_MAX_RETENTION_SECONDS,
  SQS_MIN_RETENTION_SECONDS,
} from './limits.js';

export interface SqsQueueConfig {
  /** 並列に動く consumer の数。**窓口の数**そのもの。 */
  readonly consumerCount: number;
  /**
   * メッセージ 1 件の平均処理時間 (ms)。省略時 5ms。
   * ⚠️ 仮定値（consumer のアプリケーション次第）。
   */
  readonly processingTimeMs?: number | undefined;
  /** 保持期間 (秒)。省略時 4 日。**超えたメッセージは黙って消える**。 */
  readonly messageRetentionSeconds?: number | undefined;
  /** SendMessage のレイテンシ (ms)。省略時 10ms。⚠️ 仮定値。 */
  readonly sendLatencyMs?: number | undefined;
}

export interface SqsQueueTickResult {
  readonly timeSeconds: number;

  /** producer が送ろうとした量 (件/秒)。 */
  readonly demandedMessagesPerSec: number;
  /**
   * 実際にキューへ入った量 (件/秒)。**常に需要と一致する**。
   * 入口に壁が無いことを、値が同じという形でそのまま表している。
   */
  readonly enqueuedMessagesPerSec: number;
  /**
   * 拒否された量 (件/秒)。**常に 0**。
   *
   * 定数を返すだけのフィールドを持っているのは、3 サービスの HUD で
   * 「拒否」の行を同じ位置に並べるためである。DynamoDB と Aurora が
   * 100 q/s を返している隣で SQS だけ 0 が出ていることに意味がある。
   */
  readonly rejectedMessagesPerSec: number;
  /** consumer が処理し終えた量 (件/秒)。過負荷では総容量に張り付く。 */
  readonly consumedMessagesPerSec: number;
  /**
   * 保持期間切れで消えた量 (件/秒)。**SQS 固有の、唯一のデータ損失**。
   *
   * エラーは 1 件も出ない。producer は送信に成功しており、
   * consumer は受信していない。誰も失敗していないのにメッセージだけが無い。
   */
  readonly expiredMessagesPerSec: number;

  /** キューに残っている総件数（処理中を含む）。このモデル唯一の持続状態。 */
  readonly queueDepth: number;
  /** `ApproximateNumberOfMessagesVisible`。まだ誰も取りに来ていない件数。 */
  readonly backlogVisible: number;
  /** `ApproximateNumberOfMessagesNotVisible`。いま consumer が処理中の件数。 */
  readonly inFlight: number;
  /** in-flight ÷ 120,000。1 に達すると consumer を増やしても受信できなくなる。 */
  readonly inFlightUtilization: number;

  /**
   * `ApproximateAgeOfOldestMessage` (秒)。**過負荷に気づける唯一の指標**。
   *
   * FIFO で厳密に求めている（近似していない理由は `ArrivalLedger` を参照）。
   */
  readonly oldestMessageAgeSeconds: number;
  /** 最古の年齢 ÷ 保持期間。**1 に達した瞬間から黙って消え始める**。 */
  readonly retentionUtilization: number;
  /**
   * 最古の年齢が伸びる速さ (秒/秒)。負なら縮んでいる。
   *
   * ⚠️ **`1 − 消化 ÷ 到着` で計算してはいけない。** 正しい分母は
   * 「**先頭が到着した当時の**到着レート」であって、いまのレートではない。
   * 負荷を下げた直後にこれを取り違えると、実際は伸びているのに**符号が逆**になり、
   * 「もう大丈夫」と読める値が出る — `ArrivalLedger` が近似を退けた理由そのものを
   * 派生指標で復活させることになる。
   *
   * ここでは前 tick の年齢との差から**実測**している。近似がそもそも要らない。
   */
  readonly oldestMessageAgeGrowthPerSec: number;

  /**
   * producer から見た送信レイテンシ (秒)。**バックログが何件でも動かない**。
   * producer 側の監視が無風に見える理由そのもの。
   */
  readonly sendLatencySeconds: number;
  /**
   * いま送ったメッセージがキューから出るまでの秒数（処理完了または期限切れ）。
   *
   * 前に並んでいる全員が居なくなるのを待つので、バックログに比例して伸びる。
   * ただし**並んで待つ時間が保持期間を超えることはない** — そこまで来たら前の客は消えているため。
   *
   * ⚠️ 上限は厳密には「保持期間 + 処理時間」である（処理時間を最後に足しているため）。
   * 期限切れで出ていく場合は処理されないので、その分だけ理屈の上では過大になる。
   * 処理時間は待ち時間より 3〜4 桁小さいので、分けずに 1 本の数字にしてある。
   */
  readonly endToEndLatencySeconds: number;

  /** 到着 ÷ 消化容量。1 を超えたらバックログが伸び始める。 */
  readonly offeredLoadRatio: number;
  /** バックログの増える速さ (件/秒)。負なら掃けている。 */
  readonly backlogGrowthPerSec: number;
}

/**
 * SQS Standard queue のバックログモデル。
 *
 * ## 過負荷時の壊れ方の、第 3 の類型
 *
 * | | 過負荷になると | 壁 | 検知できる指標 |
 * |---|---|---|---|
 * | DynamoDB | 即座に拒否 | パーティション容量 | エラー率 |
 * | Aurora | 待たせてから拒否 | vCPU → max_connections | レイテンシ |
 * | **SQS** | **溜める。何も起きない** | **保持期間 / in-flight** | **`ApproximateAgeOfOldestMessage`** |
 *
 * ```
 * producer ──▶ [ キュー（無制限） ] ──▶ consumer × c ──▶ 完了
 *    ↑                  │                    ↑
 *  壁が無い       壁: 保持期間           壁: 消化レート
 *  拒否 0         超えたら黙って消える    = c ÷ 処理時間
 * ```
 *
 * 状態は **backlog Q（件）1 つ**。Aurora の待ち行列より単純で、
 * **乱数も Erlang C も要らない** — producer は待たされないので、
 * 窓口のゆらぎが producer 側へ一切伝わらないからである。
 * この経路には確率的な要素が 1 つも無く、3 サービス中もっとも強く決定論的になる。
 *
 * ## キューは障害を消さない。時間軸へ引き伸ばす
 *
 * 同じ 500 q/s を、どれも容量 400 q/s のサービスへ流したとき:
 *
 * | | 受理 | 拒否 | 症状 |
 * |---|---|---|---|
 * | DynamoDB | 400 q/s | 100 q/s | 5 ms 一定 |
 * | Aurora | 400 q/s | 100 q/s | 2,646 ms |
 * | **SQS** | **500 q/s（全部）** | **0** | **何も起きない。100 件/秒ずつ溜まる** |
 *
 * そして回復側が本題である。Aurora の行列は再送さえ無ければ 30 秒で掃けるが、
 * SQS のバックログは**過負荷が続いた時間に比例して**回復が遅れる。
 * 超過分と余剰が等しければ、**過負荷が続いたのと同じ時間だけ**復旧にかかる。
 *
 * ## キューの深さの上限は「到着レート × 保持期間」
 *
 * 無制限に積めるはずのキューに、時間の壁が実効的な上限を作る。
 * ⚠️ この上限に **consumer の消化レートは 1 ミリも効かない**。
 * キューに残っているのは「保持期間ぶんの到着量」そのものだからである
 * （それより古いものは、捌けたか消えたかのどちらかで、もう居ない）。
 *
 * 到着 500 件/秒・保持 60 秒なら、consumer が 2 個でも 200 個でも上限は 30,000 件。
 * 違うのは**そこへ到達するかどうか**だけで、consumer が足りていれば列は伸びずに終わる。
 *
 * ## スコープ外（意図的に入れていないもの）
 *
 * - **FIFO キュー** — TPS 上限という別の壁が入り、Standard の「入口に壁が無い」が濁る
 * - **DLQ / 可視性タイムアウト超過による二重処理** — Aurora の再送増幅と同型で価値は高いが、
 *   まず「溜まるだけ」の基本形を通す
 * - **ロングポーリング / バッチ受信** — API 呼び出し回数の話であって、バックログの話ではない
 */
export class SqsQueue {
  #consumerCount: number;
  #processingTimeSeconds: number;
  #retentionSeconds: number;
  readonly #sendLatencySeconds: number;

  /** 累積到着量の折れ線。最古メッセージの年齢を厳密に引くために持つ。 */
  readonly #ledger = new ArrivalLedger();

  /** キューに残っている件数。tick をまたいで持続する唯一の状態。 */
  #queue = 0;
  /** キューから出ていった累計件数（消化 + 保持期間切れ）。年齢の逆引きに使う。 */
  #departed = 0;
  /** 直前 tick の最古メッセージの年齢。伸びる速さを**実測**するために持つ。 */
  #previousAgeSeconds = 0;
  #cumulativeArrivals = 0;
  #cumulativeConsumed = 0;
  #cumulativeExpired = 0;
  #elapsedSeconds = 0;

  constructor(config: SqsQueueConfig) {
    const sendLatencyMs = config.sendLatencyMs ?? SQS_DEFAULT_SEND_LATENCY_MS;
    requirePositive(sendLatencyMs, 'sendLatencyMs');
    this.#sendLatencySeconds = sendLatencyMs / 1_000;

    // すべて setter を通す。検証規則が 2 箇所に分かれると、片方だけ緩む
    // （`AuroraWriter` と同じ作法）。初期化は TypeScript の確定代入を満たすためだけのもの。
    this.#processingTimeSeconds = 0;
    this.#consumerCount = 0;
    this.#retentionSeconds = SQS_DEFAULT_RETENTION_SECONDS;
    this.processingTimeMs = config.processingTimeMs ?? SQS_DEFAULT_PROCESSING_TIME_MS;
    this.consumerCount = config.consumerCount;
    this.messageRetentionSeconds = config.messageRetentionSeconds ?? SQS_DEFAULT_RETENTION_SECONDS;
  }

  get consumerCount(): number {
    return this.#consumerCount;
  }

  /**
   * consumer 数を変える。**バックログは持ち越す。**
   *
   * Aurora のインスタンスクラス変更が待ち行列をリセットするのと**正反対**であり、
   * その非対称性こそが教材になる:
   *
   * > Aurora は障害の最中にスケールしても、フェイルオーバーで断が入るだけで逃げ切れない。
   * > SQS は溜まったバックログを consumer を増やして掃ける。**それが正しい手**である。
   *
   * ここでリセットしてしまうと「スケールしたらバックログが消えた」ことになり、
   * キューの持つ唯一にして最大の利点 —「溜めておいて後から捌ける」— が
   * 「溜めたものが無かったことになる」に化ける。
   */
  set consumerCount(value: number) {
    requirePositive(value, 'consumerCount');
    this.#consumerCount = value;
  }

  /**
   * 保持期間 (秒)。**バックログは持ち越す**（consumer 数と同じ理由）。
   *
   * ⚠️ 縮めると、すでに並んでいるメッセージが次の tick で一斉に消えることがある。
   * これはモデルの都合ではなく実機どおりの挙動で、
   * 「保持期間を下げる設定変更が、その場でデータ損失を起こす」という運用上の罠そのもの。
   */
  set messageRetentionSeconds(value: number) {
    if (
      !Number.isFinite(value) ||
      value < SQS_MIN_RETENTION_SECONDS ||
      value > SQS_MAX_RETENTION_SECONDS
    ) {
      throw new RangeError(
        `messageRetentionSeconds は ${SQS_MIN_RETENTION_SECONDS}〜${SQS_MAX_RETENTION_SECONDS} 秒である必要がある: ${value}`,
      );
    }
    this.#retentionSeconds = value;
  }

  get messageRetentionSeconds(): number {
    return this.#retentionSeconds;
  }

  get processingTimeSeconds(): number {
    return this.#processingTimeSeconds;
  }

  /**
   * 1 件あたりの処理時間 (ms) を変える。**バックログは持ち越す**（consumer 数と同じ理由）。
   *
   * 「consumer を増やす」を許して「consumer のコードを速くする」を禁じる理由は無い。
   * どちらも消化容量を上げる手であって、キューの中身には何の影響も無い。
   */
  set processingTimeMs(value: number) {
    requirePositive(value, 'processingTimeMs');
    this.#processingTimeSeconds = value / 1_000;
  }

  get sendLatencySeconds(): number {
    return this.#sendLatencySeconds;
  }

  /**
   * 実際に働ける consumer の数。**in-flight 120,000 で頭打ちになる**。
   *
   * 受信済み・未削除のメッセージが 120,000 件を超えられないので、
   * それ以上 consumer を並べても同時に持てる仕事が増えない。
   */
  get effectiveConsumerCount(): number {
    return Math.min(this.#consumerCount, SQS_MAX_IN_FLIGHT_MESSAGES);
  }

  /** consumer を増やしても消化レートが伸びない領域に入っているか。 */
  get inFlightLimited(): boolean {
    return this.#consumerCount > SQS_MAX_IN_FLIGHT_MESSAGES;
  }

  /** 消化容量 (件/秒) = 実効 consumer 数 ÷ 処理時間。**SQS で唯一の「壁」**。 */
  get capacityPerSec(): number {
    return this.effectiveConsumerCount / this.#processingTimeSeconds;
  }

  get queueDepth(): number {
    return this.#queue;
  }

  get cumulativeArrivals(): number {
    return this.#cumulativeArrivals;
  }

  get cumulativeConsumed(): number {
    return this.#cumulativeConsumed;
  }

  get cumulativeExpired(): number {
    return this.#cumulativeExpired;
  }

  get elapsedSeconds(): number {
    return this.#elapsedSeconds;
  }

  /** シミュレーションを 1 tick 進める。 */
  step(demand: Demand, dtSeconds: number): SqsQueueTickResult {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      throw new RangeError(`dtSeconds は正の有限数である必要がある: ${dtSeconds}`);
    }

    // ⚠️ NaN を必ずここで止める。Q は tick をまたいで持続するので、
    // 一度でも NaN が混じると以降どんな正常な入力を流しても復帰しない（`AuroraWriter` と同じ）。
    // SQS はさらに `ArrivalLedger` の折れ線まで壊れるので、被害が年齢の逆引きにも及ぶ。
    const demanded = finiteNonNegative(demand.readsPerSecond) + finiteNonNegative(demand.writesPerSecond);

    // ── 入口: 壁が無い。送られたものは全部入る ──
    // ここに `Math.min` が 1 つも無いことが、このモデルの主張そのものである。
    const arrived = demanded * dtSeconds;
    this.#ledger.record(demanded, dtSeconds);
    this.#queue += arrived;
    this.#cumulativeArrivals += arrived;
    this.#elapsedSeconds += dtSeconds;

    // ── 出口: consumer の消化レート。捌ける分だけ捌く ──
    const consumed = Math.min(this.#queue, this.capacityPerSec * dtSeconds);
    this.#queue -= consumed;
    this.#departed += consumed;
    this.#cumulativeConsumed += consumed;

    // ── 時間の壁: 保持期間。頭から黙って消える ──
    // 保持期間より前に到着した分は、出ていったことになっていなければ消えたということ。
    // FIFO なので消えるのは必ず頭からで、`departed` との差がそのまま消失件数になる。
    //
    // 消化を先に済ませてから期限切れを見るのは、consumer が常時ポーリングしていて
    // 「消える寸前のメッセージにも手が届く」ほうが実機に近いため。
    // どちらの順でも定常状態は変わらず、差は 1 tick ぶんに留まる。
    const cutoffCumulative = this.#ledger.cumulativeAt(this.#elapsedSeconds - this.#retentionSeconds);
    const expired = Math.min(this.#queue, Math.max(0, cutoffCumulative - this.#departed));
    this.#queue -= expired;
    this.#departed += expired;
    this.#cumulativeExpired += expired;

    // ── 最古メッセージの年齢。FIFO で厳密に逆引きする ──
    // キューが空なら「最古」が存在しないので 0。CloudWatch も空のキューでは 0 を返す。
    const oldestMessageAgeSeconds =
      this.#queue > 0 ? this.#elapsedSeconds - this.#ledger.timeAtCumulative(this.#departed) : 0;
    this.#ledger.prune(this.#departed);

    // 年齢の伸びる速さは**実測**する。閉じた式 `1 − 消化 ÷ 到着` は、
    // 分母が「先頭が到着した当時の到着レート」でなければならないため、
    // 負荷を変えた直後に符号ごと間違える。前 tick との差なら近似がそもそも要らない。
    const oldestMessageAgeGrowthPerSec =
      (oldestMessageAgeSeconds - this.#previousAgeSeconds) / dtSeconds;
    this.#previousAgeSeconds = oldestMessageAgeSeconds;

    const capacityPerSec = this.capacityPerSec;
    const consumedPerSec = consumed / dtSeconds;
    const expiredPerSec = expired / dtSeconds;
    // 処理中にできるのは窓口の数まで。残りは visible なまま待つ。
    const inFlight = Math.min(this.effectiveConsumerCount, this.#queue);

    // いま送ったメッセージがキューから出るまでの時間。
    //
    // ⚠️ `Q ÷ 消化容量` と書いてはいけない。**前に並んでいる客は消化だけでなく
    // 期限切れでも減る**ので、実際の待ち時間はそれより短くなる。
    //
    // ⚠️ さらに保持期間で頭を押さえる必要がある。期限切れが**まだ始まっていない過渡状態**では
    // 分母に期限切れ分が入らず、式が `Q ÷ 消化容量` へ退化するためである。
    // 実際、保持 60 秒のプリセットで消え始める直前（t=300 秒）に 75 秒が出る —
    // 「60 秒で消える列に 75 秒並ぶ」というありえない値。
    // どんなメッセージも保持期間を超えて並ぶことはできないので、そこで打ち止めにする。
    const departureRatePerSec = consumedPerSec + expiredPerSec;
    const waitSeconds =
      this.#queue > 0 ? Math.min(this.#queue / departureRatePerSec, this.#retentionSeconds) : 0;
    const endToEndLatencySeconds = waitSeconds + this.#processingTimeSeconds;

    return {
      timeSeconds: this.#elapsedSeconds,

      demandedMessagesPerSec: demanded,
      enqueuedMessagesPerSec: demanded,
      rejectedMessagesPerSec: 0,
      consumedMessagesPerSec: consumedPerSec,
      expiredMessagesPerSec: expiredPerSec,

      queueDepth: this.#queue,
      backlogVisible: this.#queue - inFlight,
      inFlight,
      inFlightUtilization: inFlight / SQS_MAX_IN_FLIGHT_MESSAGES,

      oldestMessageAgeSeconds,
      retentionUtilization: oldestMessageAgeSeconds / this.#retentionSeconds,
      oldestMessageAgeGrowthPerSec,

      sendLatencySeconds: this.#sendLatencySeconds,
      endToEndLatencySeconds,

      offeredLoadRatio: demanded / capacityPerSec,
      backlogGrowthPerSec: demanded - consumedPerSec,
    };
  }
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} は正の有限数である必要がある: ${value}`);
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
