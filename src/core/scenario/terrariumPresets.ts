import type { Demand, LaneKind } from '../sim/demand.js';
import { defaultAuroraLiveSettings, type AuroraLiveSettings } from './aurora/liveSession.js';
import type { DynamoDbLiveSettings } from './dynamodb/liveSession.js';
import { dynamoDbLivePresets } from './dynamodb/livePresets.js';
import { defaultSqsLiveSettings, type SqsLiveSettings } from './sqs/liveSession.js';

/**
 * 画面 1 枚ぶんの初期状態。**全サービスの設定と、共有の負荷を 1 つに束ねたもの**。
 *
 * `driver.ts` と同じ理由で `scenario/` 直下にある — 全サービスを同時に import するため
 * （PLAN.md「M3 で確定した駆動の形」の命名規約）。
 *
 * ## なぜ `DynamoDbLivePreset` に他サービスの欄を足さなかったのか
 *
 * 名前が実態からずれる。M2 のレビューで `LiveSession` → `DynamoDbLiveSession` を
 * 直したのと同じ罠を、こんどはプリセット側で踏むことになる。
 *
 * それに、この型が担う仕事は**全サービスを同時に元へ戻すこと**である。
 * インスタンスクラスや consumer 数を触ったあとにプリセットを押したとき、
 * 1 つでも前の状態が残っていると「同じ負荷で同じ容量」という看板シナリオが静かに崩れる。
 * SQS では**溜まったバックログごと**戻す必要があるので、この役割はさらに重くなった。
 */
export interface TerrariumPreset {
  readonly name: string;
  readonly lesson: string;
  /** 共有の負荷ダイヤルの初期値。**1 本しかない**。 */
  readonly load: Demand;
  readonly dynamodb: DynamoDbLiveSettings;
  readonly aurora: AuroraLiveSettings;
  readonly sqs: SqsLiveSettings;
  /**
   * DynamoDB 側で見るレーン。
   *
   * ⚠️ **Aurora / SQS には効かない**。reader を置いていない単一 writer 構成なので
   * Aurora は read と write を合算して受け、SQS も同様に合算をキューへ入れる。
   * このトグルが変えるのは DynamoDB 側の表示だけである。
   */
  readonly focusLane: LaneKind;
}

/**
 * 並置の看板シナリオで使うテーブル。
 *
 * **Aurora (db.r6g.large) / SQS (consumer 2 個) と容量をぴったり揃えてある** —
 * どちらも窓口 2 ÷ 5ms = 400 q/s であるのに対し、WCU 400 / 1KB 項目 = 400 req/s。
 * ストレージ 1GB・RCU 1,000 でパーティションは 1 本になるので、
 * テーブル全体の取り分がそのまま 1 本の壁になる。
 *
 * 揃えることが目的そのものである。容量が違えば「受理も拒否も同じ数字」が出ず、
 * 「違うのはレイテンシだけ」という Issue #9 の主張が数字の上で成立しない。
 *
 * バーストの貯金は 0 から始める。貯金があると過負荷を数十秒吸収してしまい、
 * 両者が同時に壁へ当たる瞬間がぼやける（`big-item-trap` と同じ手当て）。
 */
const matchedCapacityTable: DynamoDbLiveSettings = Object.freeze<DynamoDbLiveSettings>({
  keyCount: 500,
  capacity: {
    mode: 'provisioned',
    readCapacityUnits: 1_000,
    writeCapacityUnits: 400,
    adaptiveCapacity: true,
  },
  tableSizeGb: 1,
  itemSizeKb: 1,
  consistentRead: true,
  distribution: { kind: 'uniform' },
  initialBurstTokens: 0,
  // 2 つのプリセットで共有しているので凍らせる（`AURORA_INSTANCE_CLASSES` と同じ作法）。
  // 浅い凍結なので `capacity` の中までは守らないが、両プリセットを同時に壊す
  // 「丸ごと差し替え」の経路は塞げる。
});

/**
 * M1 / M2 のシナリオ。Aurora は既定のまま (db.r6g.large / 再送なし) で並走する。
 *
 * 負荷が DynamoDB 向けの数千〜数万 req/s なので Aurora は瞬時に飽和するが、
 * それ自体が「同じ負荷なのに壊れ方が違う」という並置の見どころになる。
 */
const dynamoDbFocusedPresets: readonly TerrariumPreset[] = dynamoDbLivePresets.map((preset) => ({
  name: preset.name,
  lesson: preset.lesson,
  load: preset.load,
  dynamodb: preset.settings,
  aurora: defaultAuroraLiveSettings,
  sqs: defaultSqsLiveSettings,
  focusLane: preset.focusLane,
}));

/**
 * 看板。**同じ負荷を、容量の等しい 3 つのサービスへ流す**。
 *
 * | | 受理 | 拒否 | 症状 |
 * |---|---|---|---|
 * | DynamoDB | 400 q/s | 100 q/s | 一桁 ms |
 * | Aurora | 400 q/s | 100 q/s | **2,651 ms** |
 * | SQS | **500 q/s（全部）** | **0** | **何も起きない。100 件/秒ずつ溜まる** |
 *
 * CloudWatch でスループットとエラー率だけを並べたら、DynamoDB と Aurora は見分けがつかない。
 * そして SQS は、**そのどちらとも似ていないのに、いちばん健全に見える**。
 * `test/terrariumPresets.test.ts` がこの数字を固定している。
 *
 * ⚠️ M3 では `same-load-both` という名前だった。3 つ目が加わって「both」が
 * 実態からずれたので改名した（このプロジェクトが繰り返し直してきた罠と同じもの）。
 */
export const sameLoadEverywhere: TerrariumPreset = {
  name: 'same-load-all',
  lesson:
    '同じ 500 q/s を、どれも容量 400 q/s のサービスへ流す。DynamoDB と Aurora は受理 400・拒否 100 まで数字が完全に一致し、違うのはレイテンシだけ（一桁 ms 対 2.6 秒）。SQS だけは 500 件すべてを受け取り、拒否 0・送信レイテンシも一定 — エラー率もレイテンシも完全に健全なまま、毎秒 100 件ずつ静かに溜まっていく。',
  load: { readsPerSecond: 0, writesPerSecond: 500 },
  dynamodb: matchedCapacityTable,
  aurora: defaultAuroraLiveSettings,
  sqs: defaultSqsLiveSettings,
  focusLane: 'write',
};

/**
 * M4 の看板。**エラーを 1 件も出さずにメッセージが消える**。
 *
 * 保持期間を 60 秒（公式の下限）まで縮めたキュー。
 * 500 q/s に対し消化 400 q/s なので、最古メッセージの年齢は
 * 毎秒 0.2 秒ずつ伸びる → **300 秒で保持期間に到達し、そこから消え始める**。
 *
 * 消え始めても、producer は送信に成功し続け、consumer は受信し続け、
 * 送信レイテンシは 1 ミリも動かない。**誰も失敗していないのにメッセージだけが無い。**
 *
 * 保持期間を既定の 4 日のままにしなかったのは、同じ現象に到達するのに
 * 4 日ぶんの仮想時間が要るためである。下限の 60 秒は公式の設定可能値なので、
 * 数値を捏造せずに現象へ手が届く。
 */
export const sqsRetentionCliff: TerrariumPreset = {
  name: 'sqs-retention-cliff',
  lesson:
    'SQS の保持期間を下限の 60 秒にして 5 分待つ。バックログの最古メッセージが 60 秒に達した瞬間から、メッセージが黙って消え始める — エラーは 1 件も出ない。producer は送信に成功し、consumer は受信に成功し、送信レイテンシも動かない。誰も失敗していないのに、メッセージだけが無い。',
  load: { readsPerSecond: 0, writesPerSecond: 500 },
  dynamodb: matchedCapacityTable,
  aurora: defaultAuroraLiveSettings,
  sqs: { consumerCount: 2, messageRetentionSeconds: 60 },
  focusLane: 'write',
};

/**
 * M3 のもう 1 枚。**エラーが 1 件も出ないまま、レイテンシだけが伸び続ける 48 秒**。
 *
 * わずか 5% の過負荷 (ρ=1.05)。待合室が 1,000 席あるので、
 * 埋まりきるまで Aurora は 1 件も拒否しない。その間にレイテンシは
 * 300ms → 2,651ms へ伸び続ける。エラー率だけ監視していると完全に無風に見える。
 *
 * 同じ 5% の過負荷を DynamoDB は**最初の 1 秒から拒否する**。
 * 「即座に拒否 / さんざん待たせてから拒否」の非対称性がここに出る。
 */
export const auroraSilentSlowdown: TerrariumPreset = {
  name: 'aurora-silent-slowdown',
  lesson:
    'たった 5% の過負荷 (420 q/s に対し容量 400 q/s)。DynamoDB は 1 秒目から 20 q/s を拒否して知らせてくるが、Aurora は待合室 1,000 席が埋まる 48 秒間、エラーを 1 件も出さない。その間にレイテンシは 300ms から 2.6 秒へ伸び続けている。',
  load: { readsPerSecond: 0, writesPerSecond: 420 },
  dynamodb: matchedCapacityTable,
  aurora: defaultAuroraLiveSettings,
  sqs: defaultSqsLiveSettings,
  focusLane: 'write',
};

/** 起動時に読み込むプリセット。まず看板を見せる。 */
export const defaultTerrariumPreset: TerrariumPreset = sameLoadEverywhere;

export const terrariumPresets: readonly TerrariumPreset[] = [
  sameLoadEverywhere,
  auroraSilentSlowdown,
  sqsRetentionCliff,
  ...dynamoDbFocusedPresets,
];

export function findTerrariumPreset(name: string): TerrariumPreset | undefined {
  return terrariumPresets.find((preset) => preset.name === name);
}
