import type { Demand } from '../../sim/demand.js';
import {
  SQS_DEFAULT_PROCESSING_TIME_MS,
  SQS_DEFAULT_RETENTION_SECONDS,
  SQS_MAX_IN_FLIGHT_MESSAGES,
} from '../../services/sqs/limits.js';
import {
  SqsQueue,
  type SqsQueueConfig,
  type SqsQueueTickResult,
} from '../../services/sqs/queue.js';

/**
 * インタラクティブに動かすときのキュー設定。
 *
 * ⚠️ 負荷 (rps) はここにも無い。`TerrariumDriver` が 1 本だけ持つ
 * （`DynamoDbLiveSettings` / `AuroraLiveSettings` と同じ）。
 */
export interface SqsLiveSettings {
  /** 並列に動く consumer の数。**スケールのダイヤル**。 */
  readonly consumerCount: number;
  /**
   * メッセージ 1 件の平均処理時間 (ms)。省略時 5ms。
   * ⚠️ 仮定値（consumer のアプリケーション次第）。
   */
  readonly processingTimeMs?: number | undefined;
  /** 保持期間 (秒)。省略時 4 日。 */
  readonly messageRetentionSeconds?: number | undefined;
}

/**
 * 起動時の設定。**consumer 2 個 × 5ms = 400 件/秒**。
 *
 * Aurora の db.r6g.large（vCPU 2 ÷ 5ms = 400 q/s）と
 * **窓口数も処理時間も容量も完全に一致させてある**。
 * 3 つ並べたとき、差が「入口に壁があるかどうか」だけに絞られる。
 */
export const defaultSqsLiveSettings: SqsLiveSettings = {
  consumerCount: 2,
};

/**
 * View 向けに整形した SQS の状態。
 *
 * ## 指標名は CloudWatch に合わせる（独自の名前を発明しない）
 *
 * | このモデルの内部 | ここでの名前 | CloudWatch |
 * |---|---|---|
 * | Q のうち未受信 | `backlogVisible` | `ApproximateNumberOfMessagesVisible` |
 * | 処理中 | `inFlight` | `ApproximateNumberOfMessagesNotVisible` |
 * | 先頭の年齢 | `oldestMessageAgeSeconds` | **`ApproximateAgeOfOldestMessage`** |
 *
 * M3 で Performance Insights の語彙に揃えたのと同じ方針。
 * 学習者が本物の CloudWatch を開いたとき、**どのグラフを見ればよいかを
 * そのまま持ち込める**ことを狙っている。
 *
 * とりわけ `ApproximateAgeOfOldestMessage` は、
 * **SQS で過負荷に気づける唯一の指標**であることをここで刷り込みたい。
 * エラー率もレイテンシもスループットも、すべて健全な値を出し続ける。
 */
export interface SqsSessionSnapshot {
  /** このキューが生きている間に刻んだ仮想時間 (秒)。作り直すと 0 に戻る。 */
  readonly simulatedSeconds: number;
  /** キューを作り直した回数。View がリセットに追随するために使う。 */
  readonly generation: number;

  readonly consumerCount: number;
  /** in-flight 120,000 で頭打ちになったあとの、実際に働ける数。 */
  readonly effectiveConsumerCount: number;
  /** consumer を増やしても消化レートが伸びない領域に入っているか。 */
  readonly inFlightLimited: boolean;
  /** 消化容量 (件/秒)。SQS で唯一の「壁」。 */
  readonly capacityPerSec: number;
  readonly processingTimeMs: number;
  readonly messageRetentionSeconds: number;
  readonly maxInFlight: number;

  readonly demandedMessagesPerSec: number;
  /** キューへ入った量。**常に需要と一致する**（入口に壁が無い）。 */
  readonly enqueuedMessagesPerSec: number;
  /** **常に 0**。DynamoDB / Aurora の隣に並べることに意味がある。 */
  readonly rejectedMessagesPerSec: number;
  readonly consumedMessagesPerSec: number;
  /** 保持期間切れで消えた量。**エラーを伴わない唯一のデータ損失**。 */
  readonly expiredMessagesPerSec: number;
  /** 累計の消失件数。レートは 0 に戻っても、失ったものは戻らない。 */
  readonly cumulativeExpired: number;

  readonly queueDepth: number;
  readonly backlogVisible: number;
  readonly inFlight: number;
  readonly inFlightUtilization: number;
  readonly backlogGrowthPerSec: number;

  /** `ApproximateAgeOfOldestMessage` (秒)。**唯一の警報**。 */
  readonly oldestMessageAgeSeconds: number;
  /** 年齢 ÷ 保持期間。**1 に達した瞬間から黙って消え始める**。 */
  readonly retentionUtilization: number;
  /**
   * 年齢が伸びる速さ (秒/秒)。負なら縮んでいる。
   *
   * バックログが減っていても**これが正なら状況は悪化している** — 負荷を下げた直後に
   * 起きる（先頭は先頭のまま置き去りにされる）。閉じた式では符号を間違えるため実測値。
   */
  readonly oldestMessageAgeGrowthPerSec: number;

  /** producer から見た送信レイテンシ (ms)。**バックログが何件でも動かない**。 */
  readonly sendLatencyMs: number;
  /** いま送ったメッセージが処理され終わるまで (ms)。バックログに比例して伸びる。 */
  readonly endToEndLatencyMs: number;
  readonly offeredLoadRatio: number;

  /**
   * いまの負荷のままバックログが掃けるまでの秒数。**復旧にかかる時間そのもの**。
   *
   * 過負荷が続いている間（消化が追いついていない間）は `undefined`。
   * 掃けないのだから残り時間は存在しない。
   *
   * ⚠️ **いまの流入と消化の差が続くと仮定した外挿**であって予測ではない
   * （Aurora の `secondsUntilConnectionsFull` と同じ性質）。
   *
   * それでも View ではなくここに置いているのは、これが M4 の教材上の主張
   * 「キューは障害を消さない。時間軸へ引き伸ばす」を数字にしたものだからである。
   * 超過分と余剰が等しければ、**過負荷が続いたのと同じ時間だけ**復旧にかかる。
   */
  readonly secondsToDrain: number | undefined;
  /**
   * 最初のメッセージが黙って消えるまでの秒数。**エラー無しでデータを失うまでの猶予**。
   *
   * すでに消え始めているか、**最古の年齢が伸びていない**なら `undefined`。
   *
   * ⚠️ 「年齢が伸びていない」は「バックログが減っている」ではない。
   * バックログが減っている最中でも年齢は伸び続けることがあり、そのとき猶予は出続ける
   * （負荷を安全域へ下げた直後がまさにそれ）。この 2 つを同一視すると、
   * 実際は消失へ向かっているのに警報だけが消える。
   *
   * ⚠️ こちらも外挿である。残り時間は**実測した**年齢の伸びる速さで割っている
   * （閉じた式で近似してはいけない理由は `oldestMessageAgeGrowthPerSec` を参照）。
   */
  readonly secondsUntilFirstExpiry: number | undefined;
}

/**
 * ダイヤルを回しながら動かし続ける SQS キューのセッション。
 *
 * `DynamoDbLiveSession` / `AuroraLiveSession` と同じ役割 —
 * 「作り直す / 作り直さない」の境界を 1 箇所に閉じ込め、
 * View には「設定を渡す」「最新の状態を読む」だけを見せる。
 *
 * ## 設定変更ではリセットしない（Aurora と正反対）
 *
 * Aurora はインスタンスクラスを変えると待ち行列がリセットされる
 * （実機がフェイルオーバーを伴うため）。**SQS にはそれに相当するものが無い。**
 * consumer を増やすのはキューの外側の話で、キューそのものは何も起きない。
 *
 * この非対称性がそのまま教材になる:
 *
 * > Aurora は障害の最中にスケールしても逃げ切れない。
 * > SQS は溜まったバックログを consumer を増やして掃ける。**それが正しい手**である。
 *
 * ここでリセットしてしまうと「スケールしたらバックログが消えた」ことになり、
 * キューの唯一にして最大の利点 —「溜めておいて後から捌ける」— が
 * 「溜めたものが無かったことになる」に化ける。
 *
 * → したがって `update()` は**決して作り直さない**。
 *   作り直すのはプリセットを読み込む `replace()` だけである。
 */
export class SqsLiveSession {
  #settings: SqsLiveSettings;
  #queue: SqsQueue;
  #latest: SqsQueueTickResult | undefined;
  #generation = 0;
  #simulatedSeconds = 0;

  constructor(settings: SqsLiveSettings) {
    this.#settings = settings;
    this.#queue = buildQueue(settings);
  }

  get settings(): SqsLiveSettings {
    return this.#settings;
  }

  get queue(): SqsQueue {
    return this.#queue;
  }

  /** 直近の tick 結果。まだ 1 度も進んでいなければ undefined。 */
  get latest(): SqsQueueTickResult | undefined {
    return this.#latest;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * 設定を差し替える。**バックログは必ず持ち越す**（理由はクラスの解説を参照）。
   *
   * @returns 常に false（作り直さないことを、他の 2 セッションと同じ形で返す）
   */
  update(patch: Partial<SqsLiveSettings>): boolean {
    const next = { ...this.#settings, ...patch };

    // ⚠️ **全項目をまとめて検証してから、まとめて適用する。**
    //
    // 1 項目ずつ setter へ流すと、途中の項目が例外を投げたときに
    // 「consumer 数だけ新しく、保持期間は古く、`settings` はどちらでもない」状態で固定される。
    // このとき `snapshot()` は queue 由来、ControlPanel は `settings` 由来なので
    // **同じ画面が違う数字を出す** — このプロジェクトが繰り返し潰してきた乖離そのもの。
    //
    // 使い捨ての queue を 1 つ作って検証を代行させるのは、検証規則を
    // ここに書き写さないためである（書き写すと必ず片方だけ緩む）。
    // これは検証専用で、バックログを持つ本体は差し替えない。
    //
    // 設定 → 諸元の写し取りが `toQueueConfig` の 1 箇所しかないので、
    // `SqsLiveSettings` に項目が増えたとき「検証だけ古い」ことは起こらない。
    new SqsQueue(toQueueConfig(next));

    this.#queue.processingTimeMs = next.processingTimeMs ?? SQS_DEFAULT_PROCESSING_TIME_MS;
    this.#queue.consumerCount = next.consumerCount;
    this.#queue.messageRetentionSeconds = next.messageRetentionSeconds ?? SQS_DEFAULT_RETENTION_SECONDS;
    this.#settings = next;
    return false;
  }

  /**
   * 設定を**まるごと**差し替え、キューを作り直す。プリセットの読み込み用。
   *
   * `update()` に委譲してはいけない（他の 2 セッションと同じ理由）。
   * あちらはマージなので、省略可能なフィールドが前の設定から残留する。
   * そして何より、**プリセットは溜まったバックログごと初期状態へ戻すためにある**。
   *
   * @returns 常に true（作り直した）
   */
  replace(settings: SqsLiveSettings): boolean {
    // 先に作ってから差し替える。設定が不正で例外が飛んだとき、
    // 「設定は新しいのに queue は古い」状態で固定されると二度と再構築されなくなる。
    const queue = buildQueue(settings);

    this.#settings = settings;
    this.#queue = queue;
    this.#latest = undefined;
    this.#generation += 1;
    this.#simulatedSeconds = 0;
    return true;
  }

  /**
   * 1 tick 進める。**呼ぶのは `TerrariumDriver` だけ**。
   *
   * 受け取る `demand` は DynamoDB / Aurora へ渡すものと**同一の値**である。
   * これが「同じ負荷を全部へ流す」という並置の前提を構造として担保している。
   */
  step(demand: Demand, tickSeconds: number): void {
    this.#latest = this.#queue.step(demand, tickSeconds);
    this.#simulatedSeconds += tickSeconds;
  }

  /**
   * View 向けの読みやすい形に変換した現在の状態。
   *
   * 毎フレームではなく HUD の更新頻度 (10Hz 程度) で呼ぶ想定
   * （毎フレーム必要な値は `latest` から直接読む）。
   */
  snapshot(): SqsSessionSnapshot {
    const queue = this.#queue;
    const latest = this.#latest;
    return {
      simulatedSeconds: this.#simulatedSeconds,
      generation: this.#generation,

      // 設定ではなく queue に効いている値から導出する。
      // 設定側を見ると「HUD は consumer 4 と言っているが queue は 2 で回っている」がありえる。
      consumerCount: queue.consumerCount,
      effectiveConsumerCount: queue.effectiveConsumerCount,
      inFlightLimited: queue.inFlightLimited,
      capacityPerSec: queue.capacityPerSec,
      processingTimeMs: queue.processingTimeSeconds * 1_000,
      messageRetentionSeconds: queue.messageRetentionSeconds,
      maxInFlight: SQS_MAX_IN_FLIGHT_MESSAGES,

      // まだ 1 度も進んでいなければ 0 で埋める。View から分岐を追い出すため。
      demandedMessagesPerSec: latest?.demandedMessagesPerSec ?? 0,
      enqueuedMessagesPerSec: latest?.enqueuedMessagesPerSec ?? 0,
      rejectedMessagesPerSec: latest?.rejectedMessagesPerSec ?? 0,
      consumedMessagesPerSec: latest?.consumedMessagesPerSec ?? 0,
      expiredMessagesPerSec: latest?.expiredMessagesPerSec ?? 0,
      cumulativeExpired: queue.cumulativeExpired,

      queueDepth: queue.queueDepth,
      backlogVisible: latest?.backlogVisible ?? 0,
      inFlight: latest?.inFlight ?? 0,
      inFlightUtilization: latest?.inFlightUtilization ?? 0,
      backlogGrowthPerSec: latest?.backlogGrowthPerSec ?? 0,

      oldestMessageAgeSeconds: latest?.oldestMessageAgeSeconds ?? 0,
      retentionUtilization: latest?.retentionUtilization ?? 0,
      oldestMessageAgeGrowthPerSec: latest?.oldestMessageAgeGrowthPerSec ?? 0,

      sendLatencyMs: queue.sendLatencySeconds * 1_000,
      endToEndLatencyMs: (latest?.endToEndLatencySeconds ?? 0) * 1_000,
      offeredLoadRatio: latest?.offeredLoadRatio ?? 0,

      secondsToDrain: secondsToDrain(queue, latest),
      secondsUntilFirstExpiry: secondsUntilFirstExpiry(queue, latest),
    };
  }
}

/**
 * いまの負荷のままバックログが掃けるまでの秒数。
 *
 * 「消化 − 到着」がそのまま減る速さなので、残りをそれで割る。
 * **追いついていないなら掃けない**ので undefined。
 */
function secondsToDrain(queue: SqsQueue, latest: SqsQueueTickResult | undefined): number | undefined {
  if (latest === undefined || queue.queueDepth <= 0) return undefined;
  const drainPerSec = latest.consumedMessagesPerSec - latest.enqueuedMessagesPerSec;
  if (drainPerSec <= 0) return undefined;
  return queue.queueDepth / drainPerSec;
}

/**
 * 「年齢が伸びている」と見なす下限 (秒/秒)。
 *
 * ⚠️ **これが無いと、平衡点で猶予の表示が「約 200 万年」に化ける。**
 *
 * 伸びる速さは前 tick との差で実測しているので、年齢が止まっている状態では
 * **ほぼ等しい 2 数の引き算**になり、桁落ちで ±5e-13 程度の揺れが出る。
 * それを `0 / 揺れ` ではなく `残り 40 秒 / 5e-13` として割ると 6e+13 秒が出る。
 * しかも符号が揺れるので、HUD は「—」と天文学的な数字を数フレームおきに往復する。
 *
 * ⚠️ 揺れの振幅は tick 幅に反比例する（差を dt で割るため）。
 * tick を細かくするほど大きくなるので、この下限は tick 幅より先に決めてはいけない。
 */
const AGE_GROWTH_EPSILON = 1e-6;

/**
 * 最初のメッセージが黙って消えるまでの秒数。
 *
 * 保持期間までの残りを、**実測した年齢の伸びる速さ**で割る。
 * **すでに消え始めているなら猶予は無い**ので undefined。
 *
 * ⚠️ ここで `1 − 消化 ÷ 到着` という閉じた式を使ってはいけない。
 * 正しい分母は「**先頭が到着した当時の**到着レート」であって、いまのレートではない。
 * 取り違えると、負荷を安全域へ下げた直後に**符号が逆**になる —
 * 年齢は実際には伸び続けているのに、警報が消えて「もう大丈夫」に見える。
 * `ArrivalLedger` が近似を退けた理由そのものを、派生指標で復活させることになる。
 */
function secondsUntilFirstExpiry(
  queue: SqsQueue,
  latest: SqsQueueTickResult | undefined,
): number | undefined {
  if (latest === undefined || latest.expiredMessagesPerSec > 0) return undefined;
  if (latest.oldestMessageAgeGrowthPerSec < AGE_GROWTH_EPSILON) return undefined;

  const remaining = queue.messageRetentionSeconds - latest.oldestMessageAgeSeconds;
  return Math.max(0, remaining) / latest.oldestMessageAgeGrowthPerSec;
}

/**
 * 設定を queue の諸元へ写し取る。**写し取りはここ 1 箇所だけ**。
 *
 * 構築（`replace`）と検証（`update`）が同じ関数を通るので、
 * `SqsLiveSettings` に項目が増えたときに「検証だけ古い」状態が生まれない。
 */
function toQueueConfig(settings: SqsLiveSettings): SqsQueueConfig {
  return {
    consumerCount: settings.consumerCount,
    processingTimeMs: settings.processingTimeMs,
    messageRetentionSeconds: settings.messageRetentionSeconds,
  };
}

function buildQueue(settings: SqsLiveSettings): SqsQueue {
  return new SqsQueue(toQueueConfig(settings));
}
