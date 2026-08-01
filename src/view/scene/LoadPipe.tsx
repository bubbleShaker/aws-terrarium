import { useMemo } from 'react';
import type { JSX } from 'react';
import { CatmullRomCurve3, Vector3 } from 'three';
import type { SitePosition } from '../layout.js';
import { PIPE_TOP, SOURCE_HEIGHT, SPLIT_HEIGHT } from '../layout.js';

interface LoadPipeProps {
  readonly dynamodb: SitePosition;
  readonly aurora: SitePosition;
}

/**
 * 負荷の源。**1 本のパイプが 2 つへ分岐する**。
 *
 * ## なぜこれを実在させるのか
 *
 * M3 の主張は「同じ負荷を流したのに、レイテンシだけが 500 倍になる」である。
 * 調査で受理量も拒否量も完全に一致すると分かった以上、
 * **「同じ負荷を流している」が疑われた時点で主張全体が崩れる**。
 *
 * HUD に「負荷ダイヤルは 1 本です」と書くのは約束事にすぎない。
 * 1 本のパイプが目の前で 2 股に分かれていれば、それは見れば分かる事実になる。
 * 左右分割の別シーンにしなかったのはこのためである（PLAN.md「M3 の空間設計」1）。
 *
 * ここは Core の状態を一切読まない純粋な構造物である。
 * 流れている量は粒子が語るので、パイプは「経路が 1 本であること」だけを担当する。
 */
export function LoadPipe({ dynamodb, aurora }: LoadPipeProps): JSX.Element {
  // 分岐は曲線で描く。直角に折ると 2 本の別の管に見えて、
  // 「1 本が分かれた」ではなく「もともと 2 本あった」に読めてしまう。
  //
  // ⚠️ 依存はオブジェクトではなく**座標の数値**で取る。`siteOrigins()` は
  // 毎レンダー新しいオブジェクトを返すので、参照で見ると HUD の更新 (10Hz) のたびに
  // 曲線と tubeGeometry を作り直すことになる。
  const branches = useMemo(
    () =>
      [dynamodb, aurora].map((site) =>
        new CatmullRomCurve3([
          new Vector3(0, SPLIT_HEIGHT, 0),
          new Vector3(site.x * 0.35, SPLIT_HEIGHT - 0.1, site.z * 0.35),
          new Vector3(site.x * 0.85, SPLIT_HEIGHT - 0.7, site.z * 0.85),
          new Vector3(site.x, SOURCE_HEIGHT, site.z),
        ]),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 座標の値だけが形を決める
    [dynamodb.x, dynamodb.z, aurora.x, aurora.z],
  );

  return (
    <group>
      {/* 源。ここから下が「1 本の負荷」。 */}
      <mesh position={[0, (PIPE_TOP + SPLIT_HEIGHT) / 2, 0]}>
        <cylinderGeometry args={[0.16, 0.16, PIPE_TOP - SPLIT_HEIGHT, 12]} />
        <meshStandardMaterial color="#4f7fff" emissive="#2a4fbf" emissiveIntensity={0.5} />
      </mesh>

      {/* 分岐点。 */}
      <mesh position={[0, SPLIT_HEIGHT, 0]}>
        <sphereGeometry args={[0.26, 16, 16]} />
        <meshStandardMaterial color="#6f9bff" emissive="#2a4fbf" emissiveIntensity={0.6} />
      </mesh>

      {branches.map((curve, index) => (
        <mesh key={index}>
          <tubeGeometry args={[curve, 32, 0.1, 8, false]} />
          <meshStandardMaterial
            color="#4f7fff"
            emissive="#2a4fbf"
            emissiveIntensity={0.4}
            transparent
            opacity={0.75}
          />
        </mesh>
      ))}
    </group>
  );
}
