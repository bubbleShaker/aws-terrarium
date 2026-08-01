import type { Demand, LaneKind } from '../sim/demand.js';
import { defaultAuroraLiveSettings, type AuroraLiveSettings } from './aurora/liveSession.js';
import type { DynamoDbLiveSettings } from './dynamodb/liveSession.js';
import { dynamoDbLivePresets } from './dynamodb/livePresets.js';

/**
 * 画面 1 枚ぶんの初期状態。**両サービスの設定と、共有の負荷を 1 つに束ねたもの**。
 *
 * `driver.ts` と同じ理由で `scenario/` 直下にある — 両サービスを同時に import するため
 * （PLAN.md「M3 で確定した駆動の形」の命名規約）。
 *
 * ## なぜ `DynamoDbLivePreset` に Aurora の欄を足さなかったのか
 *
 * 名前が実態からずれる。M2 のレビューで `LiveSession` → `DynamoDbLiveSession` を
 * 直したのと同じ罠を、こんどはプリセット側で踏むことになる。
 *
 * それに、この型が担う仕事は**両サービスを同時に元へ戻すこと**である。
 * インスタンスクラスを触ったあとにプリセットを押したとき Aurora だけ前の状態が
 * 残っていると、「同じ負荷で同じ容量」という看板シナリオが静かに崩れる。
 */
export interface TerrariumPreset {
  readonly name: string;
  readonly lesson: string;
  /** 共有の負荷ダイヤルの初期値。**1 本しかない**。 */
  readonly load: Demand;
  readonly dynamodb: DynamoDbLiveSettings;
  readonly aurora: AuroraLiveSettings;
  /**
   * DynamoDB 側で見るレーン。
   *
   * ⚠️ **Aurora には効かない**。reader を置いていない単一 writer 構成なので、
   * Aurora は read と write を合算して受ける（`AuroraWriter.step`）。
   * このトグルが変えるのは DynamoDB 側の表示だけである。
   */
  readonly focusLane: LaneKind;
}

/**
 * 並置の看板シナリオで使うテーブル。
 *
 * **Aurora (db.r6g.large) と容量をぴったり揃えてある** — vCPU 2 ÷ 5ms/クエリ = 400 q/s に対し、
 * WCU 400 / 1KB 項目 = 400 req/s。ストレージ 1GB・RCU 1,000 でパーティションは 1 本になるので、
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
  focusLane: preset.focusLane,
}));

/**
 * M3 の看板。**同じ負荷を、容量の等しい 2 つのサービスへ流す**。
 *
 * | | 受理 | 拒否 | レイテンシ |
 * |---|---|---|---|
 * | DynamoDB | 400 q/s | 100 q/s | 一桁 ms |
 * | Aurora | 400 q/s | 100 q/s | **2,651 ms** |
 *
 * CloudWatch でスループットとエラー率だけを並べたら、この 2 つは見分けがつかない。
 * `test/terrariumPresets.test.ts` がこの数字を固定している。
 */
export const sameLoadBothSides: TerrariumPreset = {
  name: 'same-load-both',
  lesson:
    '同じ 500 q/s を、どちらも容量 400 q/s のサービスへ流す。受理 400・拒否 100 まで数字が完全に一致し、違うのはレイテンシだけ — DynamoDB は一桁 ms、Aurora は 2.6 秒。スループットとエラー率だけ見ていたら、この 2 つは見分けがつかない。',
  load: { readsPerSecond: 0, writesPerSecond: 500 },
  dynamodb: matchedCapacityTable,
  aurora: defaultAuroraLiveSettings,
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
  focusLane: 'write',
};

/** 起動時に読み込むプリセット。まず看板を見せる。 */
export const defaultTerrariumPreset: TerrariumPreset = sameLoadBothSides;

export const terrariumPresets: readonly TerrariumPreset[] = [
  sameLoadBothSides,
  auroraSilentSlowdown,
  ...dynamoDbFocusedPresets,
];

export function findTerrariumPreset(name: string): TerrariumPreset | undefined {
  return terrariumPresets.find((preset) => preset.name === name);
}
