import type { JSX } from 'react';
import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import type { LaneKind, DynamoDbLiveSession } from '../../core/scenario/dynamoDbLiveSession.js';
import { HEIGHT_AT_HARD_CAP, gridExtent } from '../layout.js';
import { PartitionColumns } from './PartitionColumns.js';
import { RequestParticles } from './RequestParticles.js';

interface TerrariumSceneProps {
  readonly session: DynamoDbLiveSession;
  readonly lane: LaneKind;
  /** テーブルを作り直した回数。柱と粒子を作り直すきっかけにする。 */
  readonly generation: number;
}

/**
 * テラリウムの中身。ここから下は Core の状態を読んで描くだけで、
 * シミュレーションのロジックは一切持たない。
 */
export function TerrariumScene({ session, lane, generation }: TerrariumSceneProps): JSX.Element {
  const extent = gridExtent(session.table.partitionCount);
  const capPlaneSize = extent + 1.5;

  return (
    <Canvas
      // 単一ホットキーの柱 (物理上限の 27 倍) の頂上まで画角に入る距離と仰角。
      // 頂上が切れると「どこまで突き抜けているか」が読めなくなる。
      camera={{ position: [extent, extent * 0.95, extent * 1.3], fov: 45 }}
      dpr={[1, 1.75]}
    >
      <color attach="background" args={['#080b12']} />
      <fog attach="fog" args={['#080b12', extent * 1.6, extent * 4.5]} />

      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 12, 8]} intensity={1.1} />
      <pointLight position={[-8, 6, -6]} intensity={0.5} color="#4f7fff" />

      {/* パーティション数が変わると柱の本数も並びも変わるので、作り直す。 */}
      <PartitionColumns key={`columns-${generation}`} session={session} lane={lane} />
      <RequestParticles key={`particles-${generation}`} session={session} lane={lane} />

      {/*
        物理上限の基準面。ここを突き抜けている柱は、
        プロビジョニングを積んでもアダプティブを入れても救えない。
      */}
      <mesh position={[0, HEIGHT_AT_HARD_CAP, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[capPlaneSize, capPlaneSize]} />
        <meshBasicMaterial color="#ff6b5b" transparent opacity={0.07} depthWrite={false} />
      </mesh>
      <gridHelper args={[capPlaneSize, 1, '#ff6b5b', '#ff6b5b']} position={[0, HEIGHT_AT_HARD_CAP, 0]} />

      <gridHelper args={[capPlaneSize * 1.6, 16, '#1b2634', '#121a24']} position={[0, -0.01, 0]} />

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={extent * 0.5}
        maxDistance={extent * 4}
        maxPolarAngle={Math.PI / 2.05}
        target={[0, 2, 0]}
      />
    </Canvas>
  );
}
