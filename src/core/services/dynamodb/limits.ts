/**
 * DynamoDB の制約値。
 *
 * この教材が誤情報を再生産しないよう、**公式ドキュメントに明記がある値**と
 * **広く引用されるが公式には明記がない値**を厳密に区別して記録する。
 * 出典は research/260801-dynamodb-vs-aurora-capacity.md に整理済み。
 *
 * 計算で使うのは素の `number` 定数。出典情報は `LIMIT_PROVENANCE` に別途持たせる。
 * こうしておくと計算側は値だけ見ればよく、UI は確度と注記を出し分けられる。
 */

/** 1 パーティションあたりの読み取り上限 (read units/秒)。 */
export const PARTITION_MAX_READ_UNITS_PER_SEC = 3_000;

/** 1 パーティションあたりの書き込み上限 (write units/秒)。 */
export const PARTITION_MAX_WRITE_UNITS_PER_SEC = 1_000;

/** 1 read unit がカバーする項目サイズ (KB)。 */
export const READ_UNIT_ITEM_KB = 4;

/** 1 write unit がカバーする項目サイズ (KB)。 */
export const WRITE_UNIT_ITEM_KB = 1;

/** テーブルあたりのスループット既定上限。引き上げ申請可能。 */
export const TABLE_DEFAULT_MAX_READ_UNITS_PER_SEC = 40_000;
export const TABLE_DEFAULT_MAX_WRITE_UNITS_PER_SEC = 40_000;

/** 未使用キャパシティを貯めておける秒数 (バーストキャパシティ)。 */
export const BURST_WINDOW_SECONDS = 300;

/** パーティション分割の目安となるストレージ容量 (GB)。⚠️ 公式明記ではない。 */
export const PARTITION_SIZE_ESTIMATE_GB = 10;

export type LimitConfidence =
  /** 現行の公式ドキュメントに数値が明記されている */
  | 'documented'
  /** 公式に明記された値だが、AWS 自身が「依存するな」と注意している */
  | 'documented-but-best-effort'
  /** 広く流通しているが、現行の公式ドキュメントには裏付けが無い */
  | 'community-estimate';

export interface LimitProvenance {
  readonly value: number;
  readonly confidence: LimitConfidence;
  readonly label: string;
  readonly note: string;
}

/**
 * 各制約値の出典と確度。UI はこれを読んで注記を出し分ける。
 *
 * 「この数字はどこまで信じてよいのか」を利用者が判断できることを、
 * 数字そのものと同じくらい重要な教材の要件とみなしている。
 */
export const LIMIT_PROVENANCE = {
  partitionMaxReadUnitsPerSec: {
    value: PARTITION_MAX_READ_UNITS_PER_SEC,
    confidence: 'documented',
    label: '1 パーティションの読み取り上限',
    note:
      '公式: "Every partition in a DynamoDB table is designed to deliver a maximum capacity of ' +
      '3,000 read units per second and 1,000 write units per second."',
  },
  partitionMaxWriteUnitsPerSec: {
    value: PARTITION_MAX_WRITE_UNITS_PER_SEC,
    confidence: 'documented',
    label: '1 パーティションの書き込み上限',
    note: '上と同じ一文に明記されている。',
  },
  readUnitItemKb: {
    value: READ_UNIT_ITEM_KB,
    confidence: 'documented',
    label: '1 read unit がカバーする項目サイズ',
    note: '4KB までの強整合性読み取り 1 回、または結果整合性読み取り 2 回。',
  },
  writeUnitItemKb: {
    value: WRITE_UNIT_ITEM_KB,
    confidence: 'documented',
    label: '1 write unit がカバーする項目サイズ',
    note: '1KB までの書き込み 1 回。',
  },
  tableDefaultMaxReadUnitsPerSec: {
    value: TABLE_DEFAULT_MAX_READ_UNITS_PER_SEC,
    confidence: 'documented',
    label: 'テーブルあたりの読み取り既定上限',
    note: 'あくまで初期の既定値であり、ハードリミットではない。引き上げ申請できる。',
  },
  tableDefaultMaxWriteUnitsPerSec: {
    value: TABLE_DEFAULT_MAX_WRITE_UNITS_PER_SEC,
    confidence: 'documented',
    label: 'テーブルあたりの書き込み既定上限',
    note: 'あくまで初期の既定値であり、ハードリミットではない。引き上げ申請できる。',
  },
  burstWindowSeconds: {
    value: BURST_WINDOW_SECONDS,
    confidence: 'documented-but-best-effort',
    label: 'バーストキャパシティの貯金期間',
    note:
      '未使用キャパシティを最大 300 秒ぶん保持する、と公式に書かれている。' +
      'ただし AWS 自身が「ベストエフォートであり依存すべきではない」と注意しているため、' +
      '設計の前提にはできない。',
  },
  partitionSizeEstimateGb: {
    value: PARTITION_SIZE_ESTIMATE_GB,
    confidence: 'community-estimate',
    label: '1 パーティションのストレージ容量（推定）',
    note:
      '「1 パーティション = 10GB」は広く流通しているが、現行の公式ドキュメントには記載がない。' +
      '公式に 10GB として存在するのは「LSI を持つテーブルの item collection サイズ上限」であり、' +
      'それがパーティション容量の話と混同されて広まった可能性が高い。',
  },
} as const satisfies Record<string, LimitProvenance>;

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
