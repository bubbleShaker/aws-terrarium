/**
 * max-min fair 配分。全員に均等に配り、上限に達した者から抜けて残りを再分配する。
 *
 * なぜこの方式か: 「需要に比例して配る」だと、需要の小さいパーティションが
 * 満たせるはずの量すら貰えなくなる。max-min fair なら
 * 「小さい需要は必ず満たされ、余りが大きい需要へ回る」という直感に合う挙動になる。
 *
 * ⚠️ アダプティブキャパシティの実装そのものではなく、あくまでモデルである。
 * AWS は内部アルゴリズムを公開していない。
 *
 * @param ceilings 各要素が受け取れる上限
 * @param total 配れる総量
 * @returns 各要素への配分量。合計は `total` を超えず、各要素は `ceilings` を超えない
 */
export function maxMinFairShare(ceilings: readonly number[], total: number): number[] {
  const n = ceilings.length;
  const allocation = new Array<number>(n).fill(0);
  let remaining = Math.max(0, total);

  const pending = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    if ((ceilings[i] ?? 0) > 0) pending.add(i);
  }

  const epsilon = 1e-9;
  while (remaining > epsilon && pending.size > 0) {
    const share = remaining / pending.size;
    let distributed = 0;

    for (const i of [...pending]) {
      const headroom = (ceilings[i] ?? 0) - (allocation[i] ?? 0);
      const give = Math.min(share, headroom);
      if (give > 0) {
        allocation[i] = (allocation[i] ?? 0) + give;
        remaining -= give;
        distributed += give;
      }
      if ((ceilings[i] ?? 0) - (allocation[i] ?? 0) <= epsilon) pending.delete(i);
    }

    // 誰も受け取れなかった = 全員が上限に達している。余った分は使い道がない。
    if (distributed <= epsilon) break;
  }

  return allocation;
}
