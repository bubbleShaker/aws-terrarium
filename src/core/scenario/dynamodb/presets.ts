import { constantLoad, rampLoad } from '../../sim/loadProfile.js';
import { buildKeyWeights } from '../../services/dynamodb/keyDistribution.js';
import type { Scenario } from './runScenario.js';

/**
 * M1 の教材シナリオ。
 * 「同じテーブル設定でも、キーの選び方ひとつで結果が真逆になる」を並べて見せる。
 */

/** `uniformHealthy` と `singleHotKey` で共有する土台。違いをキー分布だけに絞るため。 */
const sharedCapacity = {
  mode: 'provisioned',
  readCapacityUnits: 1_000,
  writeCapacityUnits: 40_000,
} as const;

const sharedTable = {
  capacity: { ...sharedCapacity, adaptiveCapacity: true },
  tableSizeGb: 10,
  itemSizeKb: 1,
  consistentRead: true,
} as const;

/**
 * 基準線。キーは均等に散らしてある。
 *
 * ただし**完全には使い切れない**。キーはハッシュでパーティションへ配られるので、
 * 散らし方が理想的でもパーティションごとの負荷には必ずむらが出る。
 * 「均等に設計したのに 100% 使えない」のはバグではなく、ハッシュ分散の性質である。
 */
export const uniformHealthy: Scenario = {
  name: 'uniform-healthy',
  lesson:
    'キーが均等に散っていればスロットルは起きない。' +
    'ただしハッシュ分散にむらがある以上、プロビジョニング値ぎりぎりまでは使い切れない。',
  table: { ...sharedTable, keyWeights: buildKeyWeights({ kind: 'uniform' }, 500) },
  // プロビジョニング値の 6 割。むらを吸収できる余裕がある領域。
  load: constantLoad({ readsPerSecond: 0, writesPerSecond: 24_000 }),
  durationSeconds: 60,
};

/**
 * 均等キーでもプロビジョニング値いっぱいまで攻めると溢れる、を見せる。
 * `uniformHealthy` と同じ設定で負荷だけ 40,000 WCU に上げたもの。
 */
export const uniformAtFullCapacity: Scenario = {
  name: 'uniform-at-full-capacity',
  lesson:
    '40,000 WCU 積んで 40,000 WCU 流すと、均等キーでもスロットルする。' +
    'ハッシュのむらで最も重いパーティションが物理上限 1,000 WCU に当たるため。',
  table: { ...sharedTable, keyWeights: buildKeyWeights({ kind: 'uniform' }, 500) },
  load: constantLoad({ readsPerSecond: 0, writesPerSecond: 40_000 }),
  durationSeconds: 900,
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
  table: { ...sharedTable, keyWeights: buildKeyWeights({ kind: 'singleHot', hotRatio: 0.9 }, 500) },
  load: constantLoad({ readsPerSecond: 0, writesPerSecond: 30_000 }),
  durationSeconds: 60,
};

/** `singleHotKey` のアダプティブ OFF 版。ON にしても結果が変わらないことを示すための対照。 */
export const singleHotKeyWithoutAdaptive: Scenario = {
  ...singleHotKey,
  name: 'single-hot-key-without-adaptive',
  lesson: 'アダプティブ OFF。single-hot-key と結果がほとんど変わらないことを確かめるための対照。',
  table: {
    ...singleHotKey.table,
    capacity: { ...sharedCapacity, adaptiveCapacity: false },
  },
};

/**
 * アダプティブキャパシティが**効く**ケース。`adaptiveCapacity` だけを反転させて比較する。
 *
 * 条件: 偏りが複数キーに散っている (= 分割可能)、かつテーブル全体には余裕がある。
 * この 2 つが揃って初めてアダプティブキャパシティは救ってくれる。
 */
/** zipf 2 本で共有するキャパシティ設定。`adaptiveCapacity` だけを差し替えて比較する。 */
const zipfCapacity = {
  mode: 'provisioned',
  readCapacityUnits: 1_000,
  writeCapacityUnits: 20_000,
} as const;

export const zipfWithoutAdaptive: Scenario = {
  name: 'zipf-without-adaptive',
  lesson:
    '偏りがあると、テーブル全体に余裕があっても頭割りのせいでホットパーティションが溢れる。' +
    'ただし最初の数分はバーストキャパシティが肩代わりするので、すぐには表面化しない。',
  table: {
    capacity: { ...zipfCapacity, adaptiveCapacity: false },
    // ストレージが大きいのでパーティション数は 50。1 パーティションの取り分は 400 WCU しかない。
    tableSizeGb: 500,
    itemSizeKb: 1,
    consistentRead: true,
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
  table: {
    ...zipfWithoutAdaptive.table,
    capacity: { ...zipfCapacity, adaptiveCapacity: true },
  },
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
    // provisioned で writeCapacityUnits: 0 は実在しない設定なので on-demand を使う。
    // provisioned で WCU を実在する最小値 1 にすると、読み書きの和でパーティションが 2 本になり
    // 1 本あたりの取り分が 1,500 に落ちて物理上限 3,000 を下回るため、
    // 「600 req/s の壁」が観測できなくなる。この preset は 1 パーティション構成が前提。
    capacity: { mode: 'on-demand', peakReadUnitsPerSec: 3_000, peakWriteUnitsPerSec: 0 },
    tableSizeGb: 1,
    itemSizeKb: 20,
    consistentRead: true,
    keyWeights: buildKeyWeights({ kind: 'uniform' }, 500),
    // 貯金ゼロから始める。バーストがあると壁に当たる瞬間がぼやけるため。
    initialBurstTokens: 0,
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
  uniformAtFullCapacity,
  singleHotKey,
  singleHotKeyWithoutAdaptive,
  zipfWithoutAdaptive,
  zipfWithAdaptive,
  bigItemTrap,
];

export function findPreset(name: string): Scenario | undefined {
  return presets.find((scenario) => scenario.name === name);
}
