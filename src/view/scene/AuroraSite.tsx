import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { BoxGeometry, Color, type InstancedMesh, type Mesh, Object3D } from 'three';
import type { DrivenAuroraSession } from '../../core/scenario/driver.js';
import {
  REQUESTS_PER_SEAT,
  SEAT_SPACING,
  WRITER_DEPTH,
  WRITER_HEIGHT,
  WRITER_WIDTH,
  auroraSiteMetrics,
  seatPositions,
  vcpuGatePositions,
} from '../layout.js';
import { GATE_BUSY, GATE_IDLE, SEAT_EMPTY, SEAT_TAKEN, waitColor } from '../palette.js';

interface AuroraSiteProps {
  readonly session: DrivenAuroraSession;
}

/**
 * Aurora writer 1 台の設備。**窓口と待合室の距離が主題そのもの**。
 *
 * ```
 *   ╔═════════╗  writer 本体
 *   ║ ▮ ▮     ║  ← vCPU の窓口 (壁A: db.r6g.large で 2 本)
 *   ╚═════════╝
 *    ∷∷∷∷∷∷∷    ← 待合室 (壁B: max_connections 1,000 席 = 100 個の席)
 *    ∷∷∷∷∷∷∷
 * ```
 *
 * 席 1 個は 10 件（`REQUESTS_PER_SEAT`）。**並ぶ場所が捌ける本数の 500 倍広い**という
 * M3 の主題が、窓口 2 個に対して席 100 個という寸法差でそのまま見える。
 *
 * インスタンスクラスを上げると、窓口は writer の前面で本数を増やし、
 * 待合室は 100 → 400 席へ面積ごと広がる。
 *
 * ⚠️ 「上げるほど待合室ばかり増える」ではない（実際は逆で、窓口 16 倍に対し待合室 5 倍。
 * 比は 500 倍 → 156 倍へ縮まる）。見えてほしいのは比の変化ではなく、
 * **どのクラスでも窓口と待合室の桁が違う**ことのほうである。
 *
 * ## ここは何のロジックも持たない
 *
 * 席の点灯数は `queueLength / REQUESTS_PER_SEAT` を切り上げるだけで、
 * 待ち行列の計算は `AuroraWriter` が済ませてある。
 * 描画は毎フレーム `session.latest` を直読みする（`PartitionColumns` と同じ方針）。
 */
export function AuroraSite({ session }: AuroraSiteProps): JSX.Element {
  const writer = session.writer;
  const metrics = useMemo(() => auroraSiteMetrics(writer.maxConnections), [writer.maxConnections]);
  const seats = useMemo(() => seatPositions(writer.maxConnections), [writer.maxConnections]);
  const gates = useMemo(() => vcpuGatePositions(writer.maxVcpu), [writer.maxVcpu]);

  const seatRef = useRef<InstancedMesh>(null);
  const gateRef = useRef<InstancedMesh>(null);

  const scratch = useMemo(() => ({ dummy: new Object3D(), color: new Color() }), []);
  // 毎レンダー new すると輪郭のジオメトリが積み上がる。形は固定なので 1 個で足りる。
  // R3F が破棄してくれるのは自分で生成した分だけなので、これは自分で捨てる。
  const writerBox = useMemo(() => new BoxGeometry(WRITER_WIDTH, WRITER_HEIGHT, WRITER_DEPTH), []);
  useEffect(() => () => writerBox.dispose(), [writerBox]);

  /**
   * 席と窓口の**位置**を書き込む。
   *
   * 諸元が変わらない限り不変なので、毎フレームではなくここで 1 回だけ書く。
   * `useFrame` の中で毎回積み直すと、db.r6g.8xlarge では 500 個ぶんの行列を
   * 変化していないのに毎フレーム GPU へ送り直すことになる（色だけが毎フレーム変わる）。
   */
  useEffect(() => {
    const seatMesh = seatRef.current;
    const gateMesh = gateRef.current;
    if (seatMesh === null || gateMesh === null) return;
    const { dummy } = scratch;

    seats.forEach((seat, index) => {
      dummy.position.set(seat.x, 0.02, metrics.roomZ + seat.z);
      dummy.updateMatrix();
      seatMesh.setMatrixAt(index, dummy.matrix);
    });
    seatMesh.instanceMatrix.needsUpdate = true;

    gates.forEach((x, index) => {
      dummy.position.set(x, WRITER_HEIGHT * 0.42, metrics.gateZ + 0.02);
      dummy.updateMatrix();
      gateMesh.setMatrixAt(index, dummy.matrix);
    });
    gateMesh.instanceMatrix.needsUpdate = true;
  }, [seats, gates, metrics.roomZ, metrics.gateZ, scratch]);

  // 直前に書いた色。変化した時だけ塗り直す。
  const painted = useRef({ takenSeats: -1, busyRatio: -1 });

  useFrame(() => {
    const seatMesh = seatRef.current;
    const gateMesh = gateRef.current;
    if (seatMesh === null || gateMesh === null) return;

    const { color } = scratch;
    const latest = session.latest;

    // ── 待合室: 並んでいる人数ぶんの席が埋まる ──
    // 席は行列の先頭 (writer 側) から埋める。奥から埋まっていくことで、
    // 列が writer の手前で「詰まって伸びていく」向きになる。
    const takenSeats = Math.min(seats.length, Math.ceil(writer.queueLength / REQUESTS_PER_SEAT));
    if (takenSeats !== painted.current.takenSeats) {
      painted.current.takenSeats = takenSeats;
      for (let index = 0; index < seats.length; index += 1) {
        seatMesh.setColorAt(index, index < takenSeats ? color.copy(SEAT_TAKEN) : color.copy(SEAT_EMPTY));
      }
      if (seatMesh.instanceColor !== null) seatMesh.instanceColor.needsUpdate = true;
    }

    // ── 窓口: 過負荷でも本数は増えない。ここが「拒否せず待たせる」壁A ──
    // 稼働率は AAS ÷ Max vCPU、つまり Performance Insights のあの線の読み方そのもの。
    const busyRatio = Math.min(1, latest?.activeSessionsPerVcpu ?? 0);
    if (busyRatio !== painted.current.busyRatio) {
      painted.current.busyRatio = busyRatio;
      color.copy(GATE_IDLE).lerp(GATE_BUSY, busyRatio);
      for (let index = 0; index < gates.length; index += 1) gateMesh.setColorAt(index, color);
      if (gateMesh.instanceColor !== null) gateMesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* writer 本体。パーティションと違って**1 台しかない**ことが垂直スケールの正体。 */}
      <mesh position={[0, WRITER_HEIGHT / 2, metrics.writerZ]}>
        <boxGeometry args={[WRITER_WIDTH, WRITER_HEIGHT, WRITER_DEPTH]} />
        <meshStandardMaterial color="#39506d" roughness={0.5} metalness={0.25} />
      </mesh>
      {/* 輪郭。暗い背景だと箱の面が沈み、窓口だけが宙に浮いて見えるため。 */}
      <lineSegments position={[0, WRITER_HEIGHT / 2, metrics.writerZ]}>
        <edgesGeometry args={[writerBox]} />
        <lineBasicMaterial color="#7fa6d8" transparent opacity={0.7} />
      </lineSegments>

      <instancedMesh ref={gateRef} args={[undefined, undefined, gates.length]} frustumCulled={false}>
        <boxGeometry args={[(WRITER_WIDTH * 0.86) / (gates.length * 1.7), WRITER_HEIGHT * 0.5, 0.06]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {/* 待合室の床。占有率ではなくレイテンシで塗る（「どれだけ待たされているか」を面で出す）。 */}
      <RoomFloor session={session} />

      <instancedMesh ref={seatRef} args={[undefined, undefined, seats.length]} frustumCulled={false}>
        <boxGeometry args={[SEAT_SPACING * 0.62, 0.06, SEAT_SPACING * 0.62]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/**
 * 待合室の床。**レイテンシで色が変わる**。
 *
 * 席は「何人並んでいるか」(L)、床の色は「1 人がどれだけ待つか」(W) を担当する。
 * Little の法則の両辺を別の見た目に割り当てているので、重複ではない。
 * 席が埋まっていないのに床が赤い状態（＝飽和前のゆらぎで既に遅い）が起きるのが要点。
 */
function RoomFloor({ session }: { readonly session: DrivenAuroraSession }): JSX.Element {
  const metrics = useMemo(
    () => auroraSiteMetrics(session.writer.maxConnections),
    [session.writer.maxConnections],
  );
  const ref = useRef<Mesh>(null);
  const color = useMemo(() => new Color(), []);

  useFrame(() => {
    const mesh = ref.current;
    if (mesh === null) return;
    // 1 枚しかないので instancing は要らない。マテリアルの色を差し替えるだけで済む。
    const material = mesh.material;
    if (!Array.isArray(material) && 'color' in material) {
      (material.color as Color).copy(waitColor(session.latest?.latencySeconds ?? 0, color));
    }
  });

  return (
    <mesh
      ref={ref}
      position={[0, 0.005, metrics.roomZ]}
      scale={[metrics.roomWidth + SEAT_SPACING, 1, metrics.roomDepth + SEAT_SPACING]}
      frustumCulled={false}
    >
      <boxGeometry args={[1, 0.01, 1]} />
      <meshBasicMaterial transparent opacity={0.22} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}
