/**
 * Aurora のインスタンスクラス諸元。
 *
 * DynamoDB 側 (`services/dynamodb/limits.ts`) と同じ方針で、
 * **公式に明記がある値**と**仮定値**を厳密に区別する。
 *
 * ⚠️ `max_connections` は式ではなく**公式の表**を使う。
 * AWS は式の計算結果をそのまま採用していない:
 *
 * > Example: For db.r6g.large, while the formula calculates **1069.2**,
 * > the system implements **1000** to maintain consistent incremental patterns.
 *
 * 出典は research/260801-aurora-queueing-model.md §2-2 に整理済み。
 */

export interface AuroraInstanceSpec {
  /** 壁A: 同時に走れるプロセス数。M/M/c の窓口数 c そのもの。 */
  readonly vcpu: number;
  readonly memoryGib: number;
  /** 壁B: これを超えると `Too many connections` で**拒否**される。 */
  readonly maxConnections: number;
}

/**
 * このシミュレータが扱うインスタンスクラス。
 *
 * この表で一番見てほしいのは **vCPU と max_connections の距離**である。
 * db.r6g.large は vCPU 2 に対して max_connections 1,000 — その比は **500 倍**。
 *
 * > 並ぶ場所が、捌ける本数の 500 倍広い。
 * > だから Aurora は「エラーを出さずに、ひたすら遅くなる」ことができる。
 * > 接続数の上限は性能の上限ではなく、**待合室の広さ**でしかない。
 *
 * インスタンスクラスを上げても、待合室は 2〜5 倍にしかならないのに対し
 * 窓口は 2 → 32 と 16 倍になる。「メモリを増やす」より「vCPU を増やす」が効くのは
 * この表の形からそのまま読める。
 */
export const AURORA_INSTANCE_CLASSES = {
  'db.t3.medium': { vcpu: 2, memoryGib: 4, maxConnections: 90 },
  'db.r6g.large': { vcpu: 2, memoryGib: 16, maxConnections: 1_000 },
  'db.r6g.xlarge': { vcpu: 4, memoryGib: 32, maxConnections: 2_000 },
  'db.r6g.2xlarge': { vcpu: 8, memoryGib: 64, maxConnections: 3_000 },
  'db.r6g.4xlarge': { vcpu: 16, memoryGib: 128, maxConnections: 4_000 },
  'db.r6g.8xlarge': { vcpu: 32, memoryGib: 256, maxConnections: 5_000 },
} as const satisfies Record<string, AuroraInstanceSpec>;

export type AuroraInstanceClass = keyof typeof AURORA_INSTANCE_CLASSES;

export const AURORA_INSTANCE_CLASS_NAMES = Object.keys(
  AURORA_INSTANCE_CLASSES,
) as readonly AuroraInstanceClass[];

export function auroraInstanceSpec(instanceClass: AuroraInstanceClass): AuroraInstanceSpec {
  return AURORA_INSTANCE_CLASSES[instanceClass];
}

/**
 * 1 クエリの平均処理時間 (ms) の既定値。
 *
 * ⚠️ **これはこのモデル唯一の仮定値**であり、公式の値は存在しない（ワークロード次第）。
 * vCPU と max_connections が公式表の値なのとは確度がまったく違うので、
 * UI では「実測が必要な唯一のパラメータ」と明示すること。
 *
 * 5ms は db.r6g.large (vCPU 2) で総容量 400 q/s になる値で、
 * DynamoDB 側と桁を揃えて並置しやすくするために選んだ。
 */
export const DEFAULT_SERVICE_TIME_MS = 5;
