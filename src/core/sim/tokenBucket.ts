/**
 * トークンバケット。DynamoDB のバーストキャパシティを表現する。
 *
 * DynamoDB は使わなかったキャパシティを最大 300 秒ぶん貯めておき、
 * 瞬間的なスパイクに使わせてくれる。この「貯金」の挙動がトークンバケットそのもの。
 *
 * ⚠️ 上限は**構築時に固定**する。意図的にそうしている。
 * 貯金の枠も貯まる速度も「頭割りの取り分 = 払っている分」から決まるのであって、
 * アダプティブキャパシティで一時的に配分が増えても貯金が増えるわけではない。
 * ここを可変にしてアダプティブの配分に追従させると、
 * 「一度バーストを使い切ると二度と回復しない」というバグを再導入することになる
 * （詳細は research/260801-dynamodb-vs-aurora-capacity.md の 1-6 節）。
 */
export class TokenBucket {
  #tokens: number;
  readonly #capacity: number;

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
