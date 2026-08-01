import type { Demand, LaneKind } from '../../sim/demand.js';
import type { DynamoDbLiveSettings } from './liveSession.js';
import {
  bigItemTrap,
  singleHotKey,
  singleHotKeyWithoutAdaptive,
  uniformAtFullCapacity,
  uniformHealthy,
  zipfWithAdaptive,
  zipfWithoutAdaptive,
} from './presets.js';

/**
 * M1 のシナリオを、空間から選べるインタラクティブなプリセットにしたもの。
 *
 * `name` と `lesson` は M1 の `presets.ts` から**そのまま借りている**。
 * 教材の文言が 2 箇所に増えると必ず食い違うため、文章の出所は 1 つに保つ。
 * 借りていないのは負荷だけで、これはバッチ用の `LoadProfile` (時間の関数) を
 * ダイヤルの初期値 (その瞬間の値) に読み替える必要があるため。
 */
export interface DynamoDbLivePreset {
  readonly name: string;
  readonly lesson: string;
  readonly settings: DynamoDbLiveSettings;
  /**
   * 負荷ダイヤルの初期値。
   *
   * ⚠️ `settings` の中ではなく**外**にある。M3 で負荷は 1 本の共有ダイヤルになり、
   * `TerrariumDriver` が持つようになったため。
   * この分かれ目はそのまま「テーブルの形（作り直しが要る）」と
   * 「ダイヤル（回すだけ）」の境界にもなっている。
   *
   * なお、このプリセットを読み込むと Aurora 側にも同じ負荷が流れる。
   * DynamoDB 向けに選んだ数字なので Aurora は瞬時に飽和するが、
   * それ自体が「同じ負荷なのに壊れ方が違う」という M3 の見どころになる。
   */
  readonly load: Demand;
  /** このプリセットで見るべきレーン。`bigItemTrap` だけが読み取りの話。 */
  readonly focusLane: LaneKind;
}

const sharedCapacity = {
  mode: 'provisioned',
  readCapacityUnits: 1_000,
  writeCapacityUnits: 40_000,
} as const;

const sharedTable = {
  keyCount: 500,
  tableSizeGb: 10,
  itemSizeKb: 1,
  consistentRead: true,
} as const;

const zipfCapacity = {
  mode: 'provisioned',
  readCapacityUnits: 1_000,
  writeCapacityUnits: 20_000,
} as const;

const zipfTable = {
  keyCount: 500,
  // ストレージが大きいのでパーティション数は 50。1 本の取り分は 400 WCU しかない。
  tableSizeGb: 500,
  itemSizeKb: 1,
  consistentRead: true,
  distribution: { kind: 'zipf', skew: 0.7 },
} as const;

const zipfLoad: Demand = { readsPerSecond: 0, writesPerSecond: 12_000 };

/** 起動時に読み込むプリセット。まず健全な状態を見せてから壊しにいく。 */
export const defaultDynamoDbLivePreset: DynamoDbLivePreset = {
  name: uniformHealthy.name,
  lesson: uniformHealthy.lesson,
  focusLane: 'write',
  load: { readsPerSecond: 0, writesPerSecond: 24_000 },
  settings: {
    ...sharedTable,
    capacity: { ...sharedCapacity, adaptiveCapacity: true },
    distribution: { kind: 'uniform' },
  },
};

export const dynamoDbLivePresets: readonly DynamoDbLivePreset[] = [
  defaultDynamoDbLivePreset,
  {
    name: uniformAtFullCapacity.name,
    lesson: uniformAtFullCapacity.lesson,
    focusLane: 'write',
    load: { readsPerSecond: 0, writesPerSecond: 40_000 },
    settings: {
      ...sharedTable,
      capacity: { ...sharedCapacity, adaptiveCapacity: true },
      distribution: { kind: 'uniform' },
    },
  },
  {
    name: singleHotKey.name,
    lesson: singleHotKey.lesson,
    focusLane: 'write',
    load: { readsPerSecond: 0, writesPerSecond: 30_000 },
    settings: {
      ...sharedTable,
      capacity: { ...sharedCapacity, adaptiveCapacity: true },
      distribution: { kind: 'singleHot', hotRatio: 0.9 },
    },
  },
  {
    name: singleHotKeyWithoutAdaptive.name,
    lesson: singleHotKeyWithoutAdaptive.lesson,
    focusLane: 'write',
    load: { readsPerSecond: 0, writesPerSecond: 30_000 },
    settings: {
      ...sharedTable,
      capacity: { ...sharedCapacity, adaptiveCapacity: false },
      distribution: { kind: 'singleHot', hotRatio: 0.9 },
    },
  },
  {
    name: zipfWithoutAdaptive.name,
    lesson: zipfWithoutAdaptive.lesson,
    focusLane: 'write',
    load: zipfLoad,
    settings: { ...zipfTable, capacity: { ...zipfCapacity, adaptiveCapacity: false } },
  },
  {
    name: zipfWithAdaptive.name,
    lesson: zipfWithAdaptive.lesson,
    focusLane: 'write',
    load: zipfLoad,
    settings: { ...zipfTable, capacity: { ...zipfCapacity, adaptiveCapacity: true } },
  },
  {
    name: bigItemTrap.name,
    lesson: bigItemTrap.lesson,
    focusLane: 'read',
    // 壁は 600 req/s。その倍から始めて、ダイヤルを下げると壁の位置が分かる。
    load: { readsPerSecond: 1_200, writesPerSecond: 0 },
    settings: {
      keyCount: 500,
      // provisioned で WCU 0 は実在しない設定なので on-demand を使う (M1 の判断を踏襲)。
      capacity: { mode: 'on-demand', peakReadUnitsPerSec: 3_000, peakWriteUnitsPerSec: 0 },
      tableSizeGb: 1,
      itemSizeKb: 20,
      consistentRead: true,
      distribution: { kind: 'uniform' },
      // 貯金ゼロから始める。バーストがあると壁に当たる瞬間がぼやけるため。
      initialBurstTokens: 0,
    },
  },
];

export function findDynamoDbLivePreset(name: string): DynamoDbLivePreset | undefined {
  return dynamoDbLivePresets.find((preset) => preset.name === name);
}
