import type { LaneKind, DynamoDbLiveSettings } from './dynamoDbLiveSession.js';
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
export interface LivePreset {
  readonly name: string;
  readonly lesson: string;
  readonly settings: DynamoDbLiveSettings;
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
  readsPerSecond: 0,
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
  readsPerSecond: 0,
  distribution: { kind: 'zipf', skew: 0.7 },
  writesPerSecond: 12_000,
} as const;

/** 起動時に読み込むプリセット。まず健全な状態を見せてから壊しにいく。 */
export const defaultLivePreset: LivePreset = {
  name: uniformHealthy.name,
  lesson: uniformHealthy.lesson,
  focusLane: 'write',
  settings: {
    ...sharedTable,
    capacity: { ...sharedCapacity, adaptiveCapacity: true },
    distribution: { kind: 'uniform' },
    writesPerSecond: 24_000,
  },
};

export const livePresets: readonly LivePreset[] = [
  defaultLivePreset,
  {
    name: uniformAtFullCapacity.name,
    lesson: uniformAtFullCapacity.lesson,
    focusLane: 'write',
    settings: {
      ...sharedTable,
      capacity: { ...sharedCapacity, adaptiveCapacity: true },
      distribution: { kind: 'uniform' },
      writesPerSecond: 40_000,
    },
  },
  {
    name: singleHotKey.name,
    lesson: singleHotKey.lesson,
    focusLane: 'write',
    settings: {
      ...sharedTable,
      capacity: { ...sharedCapacity, adaptiveCapacity: true },
      distribution: { kind: 'singleHot', hotRatio: 0.9 },
      writesPerSecond: 30_000,
    },
  },
  {
    name: singleHotKeyWithoutAdaptive.name,
    lesson: singleHotKeyWithoutAdaptive.lesson,
    focusLane: 'write',
    settings: {
      ...sharedTable,
      capacity: { ...sharedCapacity, adaptiveCapacity: false },
      distribution: { kind: 'singleHot', hotRatio: 0.9 },
      writesPerSecond: 30_000,
    },
  },
  {
    name: zipfWithoutAdaptive.name,
    lesson: zipfWithoutAdaptive.lesson,
    focusLane: 'write',
    settings: { ...zipfTable, capacity: { ...zipfCapacity, adaptiveCapacity: false } },
  },
  {
    name: zipfWithAdaptive.name,
    lesson: zipfWithAdaptive.lesson,
    focusLane: 'write',
    settings: { ...zipfTable, capacity: { ...zipfCapacity, adaptiveCapacity: true } },
  },
  {
    name: bigItemTrap.name,
    lesson: bigItemTrap.lesson,
    focusLane: 'read',
    settings: {
      keyCount: 500,
      // provisioned で WCU 0 は実在しない設定なので on-demand を使う (M1 の判断を踏襲)。
      capacity: { mode: 'on-demand', peakReadUnitsPerSec: 3_000, peakWriteUnitsPerSec: 0 },
      tableSizeGb: 1,
      itemSizeKb: 20,
      consistentRead: true,
      distribution: { kind: 'uniform' },
      // 壁は 600 req/s。その倍から始めて、ダイヤルを下げると壁の位置が分かる。
      readsPerSecond: 1_200,
      writesPerSecond: 0,
      // 貯金ゼロから始める。バーストがあると壁に当たる瞬間がぼやけるため。
      initialBurstTokens: 0,
    },
  },
];

export function findLivePreset(name: string): LivePreset | undefined {
  return livePresets.find((preset) => preset.name === name);
}
