/**
 * トラフィックがどのパーティションキーに向かうかのモデル。
 *
 * DynamoDB の設計の良し悪しは、突き詰めると「キーの選び方」に集約される。
 * ここを差し替えるだけでホットパーティションが出たり出なかったりする、
 * というのを体感させるのがこのモジュールの役目。
 *
 * 返すのは正規化済みの重み配列（合計 1）。各要素がそのキーに向かうリクエストの割合。
 */
export type KeyWeights = readonly number[];

/** キー分布の種類。UI のプリセットと 1 対 1 に対応させる。 */
export type KeyDistributionSpec =
  | { readonly kind: 'uniform' }
  | { readonly kind: 'zipf'; readonly skew: number }
  | { readonly kind: 'singleHot'; readonly hotRatio: number };

/**
 * 理想的な設計。全キーに均等にトラフィックが散る。
 * 現実にはめったに達成できないが、比較の基準線として要る。
 */
export function uniformWeights(keyCount: number): KeyWeights {
  assertKeyCount(keyCount);
  return new Array<number>(keyCount).fill(1 / keyCount);
}

/**
 * Zipf 分布。現実的な偏りを表す。
 *
 * 重み(i) ∝ 1 / (i+1)^skew。skew を上げるほど上位のキーに集中する。
 * ユーザー ID やテナント ID をキーにしたとき、
 * 一部のヘビーユーザーにアクセスが偏る状況がこれにあたる。
 *
 * この偏りは**アダプティブキャパシティで救える**（複数キーなので分割可能）。
 * singleHot との違いがまさにそこ。
 */
export function zipfWeights(keyCount: number, skew: number): KeyWeights {
  assertKeyCount(keyCount);
  if (!Number.isFinite(skew) || skew < 0) {
    throw new RangeError(`skew は 0 以上の有限数である必要がある: ${skew}`);
  }
  const raw = Array.from({ length: keyCount }, (_, i) => 1 / (i + 1) ** skew);
  const total = raw.reduce((sum, w) => sum + w, 0);
  return raw.map((w) => w / total);
}

/**
 * 単一キーへの集中。**分割不能な最悪ケース**。
 *
 * 1 つのキーに `hotRatio` の割合が集中し、残りは他のキーへ均等に散る。
 * 「全ユーザーの書き込みを `PK = "GLOBAL_COUNTER"` の 1 項目に集約する」ような設計がこれ。
 *
 * 重要: このケースは**アダプティブキャパシティでも救えない**。
 * 1 つのパーティションキーに属するデータは複数パーティションへ分割できないため、
 * どれだけテーブル全体の WCU を積んでも 1 パーティションの上限で頭打ちになる。
 */
export function singleHotWeights(keyCount: number, hotRatio: number): KeyWeights {
  assertKeyCount(keyCount);
  if (!(hotRatio >= 0 && hotRatio <= 1)) {
    throw new RangeError(`hotRatio は 0..1 の範囲である必要がある: ${hotRatio}`);
  }
  if (keyCount === 1) return [1];
  // 均等配分より小さい hotRatio を許すと「singleHot なのに先頭が最も冷たい」分布ができてしまい、
  // 名前と中身が食い違う。ホットキーは少なくとも平均以上の重みを持つ。
  if (hotRatio < 1 / keyCount) {
    throw new RangeError(
      `hotRatio は均等配分 (${1 / keyCount}) 以上である必要がある: ${hotRatio}`,
    );
  }

  const rest = (1 - hotRatio) / (keyCount - 1);
  const weights = new Array<number>(keyCount).fill(rest);
  weights[0] = hotRatio;
  return weights;
}

/** 仕様オブジェクトから重み配列を組み立てる。UI からの入力を受ける入口。 */
export function buildKeyWeights(spec: KeyDistributionSpec, keyCount: number): KeyWeights {
  switch (spec.kind) {
    case 'uniform':
      return uniformWeights(keyCount);
    case 'zipf':
      return zipfWeights(keyCount, spec.skew);
    case 'singleHot':
      return singleHotWeights(keyCount, spec.hotRatio);
  }
}

function assertKeyCount(keyCount: number): void {
  if (!Number.isInteger(keyCount) || keyCount < 1) {
    throw new RangeError(`keyCount は 1 以上の整数である必要がある: ${keyCount}`);
  }
}
