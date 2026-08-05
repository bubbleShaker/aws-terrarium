import type { Color, Mesh } from 'three';

/**
 * メッシュ 1 枚の色を差し替える。
 *
 * 1 個しか無い物に instancing は要らない（`instanceColor` を持たないので、
 * `setColorAt` にあたる手段がそもそも無い）。
 *
 * ここに切り出してあるのは、マテリアルの型を絞り込むキャストを 1 箇所へ閉じ込めるため。
 * `Mesh.material` は「1 枚か配列か」「色を持つか」が型の上では決まらないので、
 * 呼ぶ側ごとに書くとキャストが敷地の数だけ増えていく。
 */
export function paintMesh(mesh: Mesh, color: Color): void {
  const material = mesh.material;
  if (Array.isArray(material) || !('color' in material)) return;
  (material.color as Color).copy(color);
}
