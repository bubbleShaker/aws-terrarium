import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { Color, type InstancedMesh, type Mesh, Object3D } from 'three';
import type { LaneKind, DynamoDbLiveSession } from '../../core/scenario/dynamodb/liveSession.js';
import {
  partitionBurstRatio,
  partitionThrottleRate,
} from '../../core/services/dynamodb/partitionMetrics.js';
import { ACCEPTED_WIDTH, COLUMN_WIDTH, columnHeight, damp, gridPositions } from '../layout.js';
import { acceptedColor, heatColor } from '../palette.js';

interface PartitionColumnsProps {
  readonly session: DynamoDbLiveSession;
  readonly lane: LaneKind;
}

const BURST_FULL = new Color('#26527f');
const BURST_EMPTY = new Color('#242a33');

/**
 * パーティション 1 本 = 柱 1 本。
 *
 * 3 つの量を 1 本の柱に重ねている:
 * - 外側の半透明な柱 = **需要**。色は需要 / 物理上限（赤熱の指標）
 * - 内側の実体の柱 = **実際に通った量**。スロットル中は赤に寄る
 * - 台座の色 = バーストの**貯金の残り**。明るい青が満タン、暗いと空
 *
 * 外と内を分けているのは、アダプティブキャパシティの効果が
 * 「通った量」にしか出ないため。需要（= 色）はアダプティブでは変わらない。
 * 1 本の柱にまとめてしまうと、この 2 つの区別が消える。
 *
 * 描画は毎フレーム `session.latest` を直接読む。React の state を経由しないのは、
 * 60fps で 50 本ぶんの再描画を React に通すと確実に落ちるため。
 */
export function PartitionColumns({ session, lane }: PartitionColumnsProps): JSX.Element {
  const count = session.table.partitionCount;
  const positions = useMemo(() => gridPositions(count), [count]);

  const demandRef = useRef<InstancedMesh>(null);
  const acceptedRef = useRef<InstancedMesh>(null);
  const baseRef = useRef<InstancedMesh>(null);
  const markerRef = useRef<Mesh>(null);

  // 毎フレーム new しないよう、使い回す作業用オブジェクトを 1 つずつ持つ。
  const scratch = useMemo(
    () => ({ dummy: new Object3D(), color: new Color() }),
    [],
  );
  // 目標値へ滑らかに追従させるための現在値。tick は 10Hz なので、
  // そのまま反映すると 60fps の画面ではカクつく。
  const smoothed = useMemo(
    () => ({ demand: new Float32Array(count), accepted: new Float32Array(count) }),
    [count],
  );

  useFrame((_, delta) => {
    const demandMesh = demandRef.current;
    const acceptedMesh = acceptedRef.current;
    const baseMesh = baseRef.current;
    if (demandMesh === null || acceptedMesh === null || baseMesh === null) return;

    const info = session.table.lanes[lane];
    const laneTick = session.latest?.[lane];
    const { dummy, color } = scratch;

    let hottestIndex = 0;
    let hottestDemand = -1;
    let hottestHeight = 0;

    for (let i = 0; i < count; i += 1) {
      const partition = laneTick?.partitions[i];
      const demanded = partition?.demandedUnitsPerSec ?? 0;
      const accepted = partition?.acceptedUnitsPerSec ?? 0;
      const utilization = partition?.utilizationVsHardCap ?? 0;
      // 率の定義は Core に 1 つだけ置く。ここで再実装すると、
      // Core の集計と 3D の見た目が別々の定義を持つことになる。
      const throttleRate = partitionThrottleRate(partition);
      const burstRatio = partitionBurstRatio(partition, info);

      const position = positions[i];
      if (position === undefined) continue;

      const demandHeight = damp(
        smoothed.demand[i] ?? 0,
        columnHeight(demanded, info.hardCapUnitsPerSec),
        12,
        delta,
      );
      const acceptedHeight = damp(
        smoothed.accepted[i] ?? 0,
        columnHeight(accepted, info.hardCapUnitsPerSec),
        12,
        delta,
      );
      smoothed.demand[i] = demandHeight;
      smoothed.accepted[i] = acceptedHeight;

      dummy.position.set(position.x, Math.max(demandHeight, 0.001) / 2, position.z);
      dummy.scale.set(1, Math.max(demandHeight, 0.001), 1);
      dummy.updateMatrix();
      demandMesh.setMatrixAt(i, dummy.matrix);
      demandMesh.setColorAt(i, heatColor(utilization, color));

      dummy.position.set(position.x, Math.max(acceptedHeight, 0.001) / 2, position.z);
      dummy.scale.set(1, Math.max(acceptedHeight, 0.001), 1);
      dummy.updateMatrix();
      acceptedMesh.setMatrixAt(i, dummy.matrix);
      acceptedMesh.setColorAt(i, acceptedColor(throttleRate, color));

      dummy.position.set(position.x, 0.04, position.z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      baseMesh.setMatrixAt(i, dummy.matrix);
      baseMesh.setColorAt(i, color.copy(BURST_EMPTY).lerp(BURST_FULL, Math.min(1, Math.max(0, burstRatio))));

      if (demanded > hottestDemand) {
        hottestDemand = demanded;
        hottestIndex = i;
        hottestHeight = demandHeight;
      }
    }

    demandMesh.instanceMatrix.needsUpdate = true;
    acceptedMesh.instanceMatrix.needsUpdate = true;
    baseMesh.instanceMatrix.needsUpdate = true;
    if (demandMesh.instanceColor !== null) demandMesh.instanceColor.needsUpdate = true;
    if (acceptedMesh.instanceColor !== null) acceptedMesh.instanceColor.needsUpdate = true;
    if (baseMesh.instanceColor !== null) baseMesh.instanceColor.needsUpdate = true;

    // 最も熱い 1 本を名指しする。全体の数字が隠してしまうものを、
    // 空間の側から「これだ」と指すのがこの印の役目。
    const marker = markerRef.current;
    const hottestPosition = positions[hottestIndex];
    if (marker !== null && hottestPosition !== undefined) {
      marker.visible = hottestDemand > 0;
      marker.position.set(hottestPosition.x, hottestHeight + 0.55, hottestPosition.z);
      marker.rotation.y += delta * 1.2;
    }
  });

  return (
    <group>
      <instancedMesh ref={baseRef} args={[undefined, undefined, count]} frustumCulled={false}>
        <boxGeometry args={[COLUMN_WIDTH, 0.08, COLUMN_WIDTH]} />
        <meshStandardMaterial roughness={0.6} metalness={0.1} />
      </instancedMesh>

      {/* 受理された量。実体があるものだけが「本当に通ったリクエスト」。 */}
      <instancedMesh ref={acceptedRef} args={[undefined, undefined, count]} frustumCulled={false}>
        <boxGeometry args={[ACCEPTED_WIDTH, 1, ACCEPTED_WIDTH]} />
        <meshStandardMaterial roughness={0.35} metalness={0.15} toneMapped={false} />
      </instancedMesh>

      {/* 需要。半透明なので、中の受理量との差がそのまま「弾かれた量」に見える。 */}
      <instancedMesh ref={demandRef} args={[undefined, undefined, count]} frustumCulled={false}>
        <boxGeometry args={[COLUMN_WIDTH, 1, COLUMN_WIDTH]} />
        <meshStandardMaterial
          transparent
          opacity={0.3}
          depthWrite={false}
          roughness={0.4}
          toneMapped={false}
        />
      </instancedMesh>

      <mesh ref={markerRef} visible={false}>
        <octahedronGeometry args={[0.2]} />
        <meshBasicMaterial color="#ffd166" toneMapped={false} wireframe />
      </mesh>
    </group>
  );
}
