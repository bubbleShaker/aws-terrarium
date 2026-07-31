/**
 * seed 付き擬似乱数生成器 (mulberry32)。
 *
 * なぜ自前実装か: `Math.random()` は seed を指定できない。
 * seed を指定できないと、同じ設定でシミュレーションを走らせても毎回違う結果になり、
 * 「パラメータを変えた結果、挙動がどう変わったか」を比較できず、テストも書けない。
 *
 * このプロジェクトの Core 層は「同じ入力なら常に同じ出力」であることを設計の前提にしている。
 * 乱数が必要な箇所は必ずこの Rng を経由させ、`Math.random()` を直接呼ばないこと。
 */
export class Rng {
  #state: number;

  constructor(seed: number) {
    // `>>> 0` で符号なし 32bit に丸める。負の seed や小数を渡されても壊れないようにする。
    this.#state = seed >>> 0;
  }

  /** [0, 1) の一様乱数 */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) の一様乱数 */
  nextInRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

/**
 * 決定論的な文字列ハッシュ (FNV-1a 32bit)。
 *
 * 乱数ではなくハッシュを使う理由: パーティションキーの割り当ては
 * 「同じキーは常に同じパーティションへ」でなければならない。
 * 実際の DynamoDB もキーの内部ハッシュ値で格納先パーティションを決めている。
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
