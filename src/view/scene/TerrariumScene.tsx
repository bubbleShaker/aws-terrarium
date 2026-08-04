import { useMemo } from 'react';
import type { JSX } from 'react';
import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import type { Demand, LaneKind } from '../../core/sim/demand.js';
import type { DrivenAuroraSession, DrivenDynamoDbSession } from '../../core/scenario/driver.js';
import {
  CAMERA_FOV_DEGREES,
  CAMERA_TARGET_HEIGHT,
  HEIGHT_AT_HARD_CAP,
  distanceFromInitialCamera,
  fogRange,
  gridWidth,
  initialCameraPosition,
  requestsPerParticle,
  siteOrigins,
  terrariumExtent,
} from '../layout.js';
import { AuroraParticles } from './AuroraParticles.js';
import { AuroraSite } from './AuroraSite.js';
import { LoadPipe } from './LoadPipe.js';
import { PartitionColumns } from './PartitionColumns.js';
import { RequestParticles } from './RequestParticles.js';

interface TerrariumSceneProps {
  readonly dynamodb: DrivenDynamoDbSession;
  readonly aurora: DrivenAuroraSession;
  /** 共有の負荷ダイヤルの現在値。**粒子の縮尺はここから導く**。 */
  readonly load: Demand;
  readonly lane: LaneKind;
  /** テーブルを作り直した回数。柱と粒子を作り直すきっかけにする。 */
  readonly dynamoDbGeneration: number;
  /** writer を作り直した回数。待ち行列がリセットされた合図。 */
  readonly auroraGeneration: number;
}

/**
 * テラリウムの中身。ここから下は Core の状態を読んで描くだけで、
 * シミュレーションのロジックは一切持たない。
 *
 * ## 1 つの空間に 3 つ置く（弓なり配置）
 *
 * ```
 *                  [源] ← 負荷ダイヤルは 1 本
 *                    │
 *          ┌─────────┼─────────┐
 *          ▼         ▼         ▼
 *                 ════▓▓▓▓░░···→  ← SQS は中央奥。列だけが伸びる
 *    ▓▓ ██ ▓▓            ╔═════╗ writer
 *    ▓▓ ▓▓ ▓▓            ╚═════╝
 *      ✦  ✦               ∷∷∷∷∷ ← 待合室
 *   頂上で赤く散る        手前で詰まる     何も起きない
 * ```
 *
 * 分割した別シーンにしていないのは、**負荷の源を 1 本のパイプとして実在させる**ため
 * （PLAN.md「M3 の空間設計」1）。調査で受理量も拒否量も完全に一致すると分かった以上、
 * 「同じ負荷を流している」が HUD 上の約束事でしかないと主張全体が崩れる。
 *
 * 3 つ目を横一列ではなく**中央奥**へ置いたのは、横幅を増やさない唯一の置き方だから
 * （横一列にするとカメラが 1.6 倍引き、M2 / M3 の見どころが読めなくなる。
 * PLAN.md「M4-2 の壁 1」）。
 *
 * ## 粒子の縮尺は 1 箇所で決める
 *
 * `requestsPerParticle` をここで 1 回だけ計算して全サービスへ配る。
 * サービスごとに計算させると、1 つだけ式を変えたときに静かにずれる —
 * しかも症状は「同じ負荷なのに流れの太さが違う」なので、
 * バグではなく発見に見えてしまう（時計を 1 本にしたのと同じ理由）。
 */
export function TerrariumScene({
  dynamodb,
  aurora,
  load,
  lane,
  dynamoDbGeneration,
  auroraGeneration,
}: TerrariumSceneProps): JSX.Element {
  const partitionCount = dynamodb.table.partitionCount;
  const maxConnections = aurora.writer.maxConnections;

  const origins = siteOrigins(partitionCount, maxConnections);
  const extent = terrariumExtent(partitionCount, maxConnections);
  // ⚠️ 基準面は**格子の実寸**から出す。カメラ距離用の `gridExtent` を使うと、
  // パーティション 1 本のテーブルで下限 6 が効いて面だけが敷地の 5 倍に広がり、
  // 隣の Aurora の敷地へめり込む。
  const capPlaneSize = gridWidth(partitionCount) + 1.2;
  // 縮尺は**ダイヤルが出している総量**から決める。両レーンを足しているのは
  // 「この画面がいま何 q/s を流しているか」を出すためであって、
  // どちらのサービスが何を受けるかというドメイン規則の再実装ではない
  // （Aurora が両レーンを合算して受けることは Core の `AuroraWriter` が決めている）。
  const scale = requestsPerParticle(load.readsPerSecond + load.writesPerSecond);

  // ⚠️ カメラの設定は**参照ごと固定**する。App は HUD のために 10Hz で再描画されるので、
  // 毎レンダー新しいオブジェクトを渡すと、その都度カメラが初期位置へ引き戻されて
  // 視点を動かせなくなる（OrbitControls と綱引きになる）。
  const camera = useMemo(
    () => ({ position: initialCameraPosition(extent), fov: CAMERA_FOV_DEGREES }),
    [extent],
  );

  // ⚠️ 霧の範囲は決め打ちにしない。SQS を奥へ置いた時点で、
  // 決め打ちの `[extent * 1.8, extent * 5]` では**3 つ目だけが 5 割方沈む**。
  const [fogNear, fogFar] = fogRange(extent, distanceFromInitialCamera(extent, origins.sqs));

  return (
    <Canvas camera={camera} dpr={[1, 1.75]}>
      <color attach="background" args={['#080b12']} />
      <fog attach="fog" args={['#080b12', fogNear, fogFar]} />

      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 12, 8]} intensity={1.1} />
      <pointLight position={[-8, 6, -6]} intensity={0.5} color="#4f7fff" />

      <LoadPipe sites={[origins.dynamodb, origins.aurora, origins.sqs]} />

      <group position={[origins.dynamodb.x, 0, origins.dynamodb.z]}>
        {/* パーティション数が変わると柱の本数も並びも変わるので、作り直す。 */}
        <PartitionColumns key={`columns-${dynamoDbGeneration}`} session={dynamodb} lane={lane} />
        <RequestParticles
          key={`ddb-particles-${dynamoDbGeneration}`}
          session={dynamodb}
          lane={lane}
          requestsPerParticle={scale}
        />

        {/*
          物理上限の基準面。ここを突き抜けている柱は、
          プロビジョニングを積んでもアダプティブを入れても救えない。
        */}
        <mesh position={[0, HEIGHT_AT_HARD_CAP, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[capPlaneSize, capPlaneSize]} />
          <meshBasicMaterial color="#ff6b5b" transparent opacity={0.07} depthWrite={false} />
        </mesh>
        <gridHelper
          args={[capPlaneSize, 1, '#ff6b5b', '#ff6b5b']}
          position={[0, HEIGHT_AT_HARD_CAP, 0]}
        />
      </group>

      <group position={[origins.aurora.x, 0, origins.aurora.z]}>
        {/* インスタンスクラスを変えると writer ごと作り直される（＝フェイルオーバー）。 */}
        <AuroraSite key={`aurora-site-${auroraGeneration}`} session={aurora} />
        <AuroraParticles
          key={`aurora-particles-${auroraGeneration}`}
          session={aurora}
          requestsPerParticle={scale}
        />
      </group>

      <gridHelper args={[extent * 3, 24, '#1b2634', '#121a24']} position={[0, -0.01, 0]} />

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={extent * 0.5}
        maxDistance={extent * 4}
        maxPolarAngle={Math.PI / 2.05}
        target={[0, CAMERA_TARGET_HEIGHT, 0]}
      />
    </Canvas>
  );
}
