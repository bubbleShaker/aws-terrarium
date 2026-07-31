import { constantLoad, rampLoad } from '../sim/loadProfile.js';
import { buildKeyWeights } from '../services/dynamodb/keyDistribution.js';
import type { Scenario } from './runScenario.js';

/**
 * M1 の教材シナリオ。
 * 「同じテーブル設定でも、キーの選び方ひとつで結果が真逆になる」を並べて見せる。
 */

/** 基準線。理想的にキーが散っている状態。スロットルは起きない。 */
export const uniformHealthy: Scenario = {
  name: 'uniform-healthy',
  lesson: 'キーが均等に散っていれば、40,000 WCU は 40,000 WCU として使える。これが基準線。',
  table: {
    capacity: { mode: 'provisioned', readCapacityUnits: 1_000, writeCapacityUnits: 40_000 },
    tableSizeGb: 10,
    itemSizeKb: 1,
    consistentRead: true,
    adaptiveCapacity: true,
    keyWeights: buildKeyWeights({ kind: 'uniform' }, 500),
  },
  load: constantLoad({ readsPerSecond: 0, writesPerSecond: 30_000 }),
  durationSeconds: 60,
};

/**
 * このプロジェクトで最初に見せたい 1 枚。
 * `uniformHealthy` とテーブル設定は**まったく同じ**。違うのはキーの分布だけ。
 */
export const singleHotKey: Scenario = {
  name: 'single-hot-key',
  lesson:
    'テーブルに 40,000 WCU 積んでも、1 つのキーに集中したら 1,000 WCU で頭打ち。' +
    'アダプティブキャパシティを ON にしても救えない。単一キーは分割できないから。',
  table: {
    capacity: { mode: 'provisioned', readCapacityUnits: 1_000, writeCapacityUnits: 40_000 },
    tableSizeGb: 10,
    itemSizeKb: 1,
    consistentRead: true,
    adaptiveCapacity: true, // ON にしてもなお救えない、という点が肝
    keyWeights: buildKeyWeights({ kind: 'singleHot', hotRatio: 0.9 }, 500),
  },
  load: constantLoad({ readsPerSecond: 0, writesPerSecond: 30_000 }),
  durationSeconds: 60,
};

/**
 * アダプティブキャパシティが**効く**ケース。`adaptiveCapacity` だけを反転させて比較する。
 *
 * 条件: 偏りが複数キーに散っている (= 分割可能)、かつテーブル全体には余裕がある。
 * この 2 つが揃って初めてアダプティブキャパシティは救ってくれる。
 */
export const zipfWithoutAdaptive: Scenario = {
  name: 'zipf-without-adaptive',
  lesson:
    '偏りがあると、テーブル全体に余裕があっても頭割りのせいでホットパーティションが溢れる。' +
    'ただし最初の数分はバーストキャパシティが肩代わりするので、すぐには表面化しない。',
  table: {
    capacity: { mode: 'provisioned', readCapacityUnits: 1_000, writeCapacityUnits: 20_000 },
    // ストレージが大きいのでパーティション数は 50。1 パーティションの取り分は 400 WCU しかない。
    tableSizeGb: 500,
    itemSizeKb: 1,
    consistentRead: true,
    adaptiveCapacity: false,
    keyWeights: buildKeyWeights({ kind: 'zipf', skew: 0.7 }, 500),
  },
  // 最も熱いパーティションの需要が 1,000 WCU (パーティション上限) を下回るよう調整してある。
  // 上限に当たってしまうとアダプティブでも救えなくなり、この 2 本の対比がぼやけるため。
  load: constantLoad({ readsPerSecond: 0, writesPerSecond: 12_000 }),
  // 60 秒ではバーストが全部吸収してしまい、何も起きていないように見える。
  // バーストの貯金 (400 WCU × 300 秒 = 120,000) が尽きるところまで走らせて初めて壊れる。
  durationSeconds: 900,
};

export const zipfWithAdaptive: Scenario = {
  ...zipfWithoutAdaptive,
  name: 'zipf-with-adaptive',
  lesson: 'アダプティブキャパシティは、アイドルなパーティションの余剰をホットな方へ回して救ってくれる。',
  table: { ...zipfWithoutAdaptive.table, adaptiveCapacity: true },
};

/**
 * 項目サイズの罠。
 * 「3,000 read units/秒」は「3,000 リクエスト/秒」ではない。
 */
export const bigItemTrap: Scenario = {
  name: 'big-item-trap',
  lesson:
    '1 パーティション 3,000 read units/秒 でも、20KB の項目なら 1 回の読み取りが 5 units。' +
    'つまり秒 600 リクエストで頭打ちになる。',
  table: {
    capacity: { mode: 'provisioned', readCapacityUnits: 3_000, writeCapacityUnits: 100 },
    tableSizeGb: 1,
    itemSizeKb: 20,
    consistentRead: true,
    adaptiveCapacity: true,
    keyWeights: buildKeyWeights({ kind: 'uniform' }, 500),
  },
  load: rampLoad({
    from: { readsPerSecond: 0, writesPerSecond: 0 },
    to: { readsPerSecond: 1_200, writesPerSecond: 0 },
    durationSeconds: 60,
  }),
  durationSeconds: 60,
};

export const presets: readonly Scenario[] = [
  uniformHealthy,
  singleHotKey,
  zipfWithoutAdaptive,
  zipfWithAdaptive,
  bigItemTrap,
];

export function findPreset(name: string): Scenario | undefined {
  return presets.find((scenario) => scenario.name === name);
}
