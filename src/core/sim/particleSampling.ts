/**
 * 粒子のサンプリング。
 *
 * 30,000 req/s を粒子 1 個ずつ描いたら即死するので、
 * **統計値は正確なまま、描く粒子だけ固定数に間引く**のがこのプロジェクトの一貫した方針
 * (PLAN.md「なぜ tick ベースのハイブリッドか」)。
 *
 * ここは「固定数をどう配るか」だけを担う純粋な関数。three.js は知らない。
 */

/**
 * 重みに比例して `total` 個を整数配分する（最大剰余方式）。
 *
 * 単純に `round(weight * total)` すると合計が `total` からずれる。
 * 粒子の場合は「用意したバッファの本数と実際に使う本数が食い違う」ことになり、
 * 使われないゴミが画面のどこかに残る。合計が必ず一致する方式を使う。
 */
export function allocateByWeight(weights: readonly number[], total: number): number[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError(`total は 0 以上の整数である必要がある: ${total}`);
  }
  const counts = new Array<number>(weights.length).fill(0);
  if (weights.length === 0 || total === 0) return counts;

  const sum = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
  if (sum <= 0) return counts;

  const remainders: { index: number; fraction: number }[] = [];
  let assigned = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const share = (Math.max(0, weights[i] ?? 0) / sum) * total;
    const whole = Math.floor(share);
    counts[i] = whole;
    assigned += whole;
    remainders.push({ index: i, fraction: share - whole });
  }

  // 端数の大きい順に 1 個ずつ配る。同点は index の小さい方を優先し、結果を決定論的にする。
  remainders.sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));
  for (let i = 0; assigned < total; i += 1) {
    const target = remainders[i % remainders.length];
    if (target === undefined) break;
    counts[target.index] = (counts[target.index] ?? 0) + 1;
    assigned += 1;
  }

  return counts;
}
