/**
 * DynamoDB の制約値。
 *
 * この教材が誤情報を再生産しないよう、**公式ドキュメントに明記がある値**と
 * **広く引用されるが公式には明記がない値**を厳密に区別して記録する。
 * 出典は research/260801-dynamodb-vs-aurora-capacity.md に整理済み。
 */

/** 公式明記の値かどうかを型で区別する。UI 側で注記を出し分けるために使う。 */
export interface DocumentedLimit {
  readonly value: number;
  readonly confidence: 'documented' | 'community-estimate';
  readonly note: string;
}

/**
 * 1 パーティションあたりの読み取り上限 (read units/秒)。★公式明記
 *
 * > Every partition in a DynamoDB table is designed to deliver a maximum capacity of
 * > 3,000 read units per second and 1,000 write units per second.
 */
export const PARTITION_MAX_READ_UNITS_PER_SEC = 3_000;

/** 1 パーティションあたりの書き込み上限 (write units/秒)。★公式明記 */
export const PARTITION_MAX_WRITE_UNITS_PER_SEC = 1_000;

/** 1 read unit がカバーする項目サイズ (KB)。4KB までの強整合性読み取り 1 回。★公式明記 */
export const READ_UNIT_ITEM_KB = 4;

/** 1 write unit がカバーする項目サイズ (KB)。1KB までの書き込み 1 回。★公式明記 */
export const WRITE_UNIT_ITEM_KB = 1;

/** テーブルあたりのスループット既定上限。引き上げ申請可能。★公式明記 */
export const TABLE_DEFAULT_MAX_READ_UNITS_PER_SEC = 40_000;
export const TABLE_DEFAULT_MAX_WRITE_UNITS_PER_SEC = 40_000;

/** 未使用キャパシティを貯めておける秒数 (バーストキャパシティ)。★公式明記 */
export const BURST_WINDOW_SECONDS = 300;

/**
 * パーティション分割の目安となるストレージ容量 (GB)。⚠️ 公式明記ではない
 *
 * 「1 パーティション = 10GB」は広く流通しているが、現行の公式ドキュメントには記載がない。
 * 公式に 10GB として存在するのは「LSI を持つテーブルの item collection サイズ上限」であり、
 * それがパーティション容量の話と混同されて広まった可能性が高い。
 *
 * 本シミュレータではパーティション数の推定に使うが、UI 上では推定値である旨を明示すること。
 */
export const PARTITION_SIZE_ESTIMATE: DocumentedLimit = {
  value: 10,
  confidence: 'community-estimate',
  note:
    '「1 パーティション = 10GB」は現行の公式ドキュメントに明記がない。' +
    '公式の 10GB は LSI を持つテーブルの item collection 上限であり、混同されている可能性が高い。',
};

/**
 * 読み取り 1 回が消費する read units を求める。
 *
 * ここが体感の要。項目サイズが 4KB を超えると 1 リクエストで複数ユニットを食うため、
 * 「パーティションは 3,000 read units/秒」であっても
 * 20KB の項目なら**秒 600 リクエストしか捌けない**（公式ドキュメントの例そのもの）。
 */
export function readUnitsPerRequest(itemSizeKb: number, consistentRead: boolean): number {
  const units = Math.ceil(Math.max(itemSizeKb, 0.001) / READ_UNIT_ITEM_KB);
  // 結果整合性読み取りは強整合性の半分のコストで済む。
  return consistentRead ? units : units / 2;
}

/** 書き込み 1 回が消費する write units を求める。 */
export function writeUnitsPerRequest(itemSizeKb: number): number {
  return Math.ceil(Math.max(itemSizeKb, 0.001) / WRITE_UNIT_ITEM_KB);
}
