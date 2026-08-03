/**
 * SQS Standard queue の諸元。
 *
 * DynamoDB 側 (`services/dynamodb/limits.ts`) / Aurora 側 (`services/aurora/instanceClasses.ts`)
 * と同じ方針で、**公式に明記がある値**と**仮定値**を厳密に区別する。
 *
 * 出典:
 * - https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
 * - https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html
 *
 * ## この表で一番見てほしいこと — **入口に壁が無い**
 *
 * DynamoDB には「パーティションあたり 1,000 WCU」があり、Aurora には
 * 「max_connections」がある。SQS Standard には**それに相当する定数が存在しない**。
 * 公式は "a very high, nearly unlimited number of API calls per second" と書いており、
 * キューに積めるメッセージ数も無制限である。
 *
 * > SQS の壁は入口ではなく、**出口（consumer の消化レート）と時間（保持期間）**にある。
 *
 * だから過負荷時、producer から見える指標（エラー率・送信レイテンシ）は
 * **完全に健全なまま**で、溜まっていることに気づく手段が
 * `ApproximateAgeOfOldestMessage` しかない。
 */

/**
 * in-flight（受信済み・未削除）メッセージの上限。**Standard queue で約 120,000 件**。
 *
 * 唯一の同時実行の壁なので、consumer をこれ以上並べても消化レートは伸びない。
 * ただし既定の教材シナリオ（consumer 数個）では遥か手前なので、
 * 実際に効くのは「Lambda の同時実行数を上げていったらどこで頭打ちになるか」を
 * 見る段階（M4-2 以降）である。
 *
 * ⚠️ これは**キューに積める件数の上限ではない**。積める件数は無制限で、
 * 上限があるのは「同時に処理中にできる件数」だけ。この 2 つの混同が
 * 「SQS にも容量制限がある」という誤解の出どころになる。
 */
export const SQS_MAX_IN_FLIGHT_MESSAGES = 120_000;

/** メッセージ保持期間の既定値 (秒)。**4 日**。 */
export const SQS_DEFAULT_RETENTION_SECONDS = 4 * 24 * 60 * 60;

/** 保持期間の下限 (秒)。60 秒（1 分）。 */
export const SQS_MIN_RETENTION_SECONDS = 60;

/** 保持期間の上限 (秒)。**14 日**。ここを超えたメッセージは黙って消える。 */
export const SQS_MAX_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * メッセージ 1 件の平均処理時間 (ms) の既定値。
 *
 * ⚠️ **仮定値**。公式の値は存在しない（consumer のアプリケーション次第）。
 *
 * 5ms は `AURORA_DEFAULT_SERVICE_TIME_MS` と同じ値を意図的に選んでいる。
 * consumer 2 個 × 5ms = **400 件/秒** となり、Aurora の db.r6g.large
 * （vCPU 2 ÷ 5ms = 400 q/s）と**窓口数も処理時間も容量も完全に一致する**。
 *
 * 揃えることが目的そのものである。3 サービスを並べたとき、
 * **違いが「入口に壁があるかどうか」だけに絞られる**ようにするため。
 */
export const SQS_DEFAULT_PROCESSING_TIME_MS = 5;

/**
 * SendMessage のレイテンシ (ms) の既定値。
 *
 * ⚠️ **仮定値**。ただしこの値が何であるかは教材上ほとんど問題にならない。
 * 重要なのは「**バックログが何百万件に膨らんでいる最中でも、この値は 1 ミリも動かない**」
 * という事実のほうである。producer 側の監視ダッシュボードが完全な無風に見える理由がこれ。
 */
export const SQS_DEFAULT_SEND_LATENCY_MS = 10;
