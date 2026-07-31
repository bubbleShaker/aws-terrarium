/**
 * トークンバケット。DynamoDB のバーストキャパシティを表現する。
 *
 * DynamoDB は使わなかったキャパシティを最大 300 秒ぶん貯めておき、
 * 瞬間的なスパイクに使わせてくれる。この「貯金」の挙動がトークンバケットそのもの。
 *
 * 容量は可変にしてある。アダプティブキャパシティが働くと
 * パーティションごとの割り当てレートが毎 tick 変わり、それに応じて貯金の上限も動くため。
 */
export class TokenBucket {
  #tokens: number;
  #capacity: number;

  constructor(capacity: number, initialTokens = capacity) {
    this.#capacity = Math.max(0, capacity);
    this.#tokens = clamp(initialTokens, 0, this.#capacity);
  }

  get tokens(): number {
    return this.#tokens;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** 上限を変える。上限が下がった場合は貯金も切り詰める。 */
  setCapacity(capacity: number): void {
    this.#capacity = Math.max(0, capacity);
    this.#tokens = Math.min(this.#tokens, this.#capacity);
  }

  /** トークンを補充する。上限を超えた分は捨てられる（使わなかったキャパシティは無限には貯まらない）。 */
  refill(amount: number): void {
    if (amount <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + amount);
  }

  /**
   * トークンを消費する。
   * 要求量に足りなければ**あるだけ**消費し、実際に消費できた量を返す。
   * 「全部か無しか」ではなく部分的に通すのは、DynamoDB のスロットルが
   * リクエスト単位で起きる（一部は通り、一部は弾かれる）挙動に対応させるため。
   */
  consume(amount: number): number {
    if (amount <= 0) return 0;
    const granted = Math.min(amount, this.#tokens);
    this.#tokens -= granted;
    return granted;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
