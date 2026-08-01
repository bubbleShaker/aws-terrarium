import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { JSX } from 'react';
import type { BufferAttribute, Points } from 'three';
import type { LaneKind } from '../../core/sim/demand.js';
import type { DrivenDynamoDbSession } from '../../core/scenario/driver.js';
import { allocateByWeight } from '../../core/sim/particleSampling.js';
import { Rng } from '../../core/sim/rng.js';
import { partitionThrottleRate } from '../../core/services/dynamodb/partitionMetrics.js';
import {
  PARTICLE_BUDGET,
  SOURCE_HEIGHT,
  columnHeight,
  gridPositions,
  particleCount,
} from '../layout.js';

interface RequestParticlesProps {
  readonly session: DrivenDynamoDbSession;
  readonly lane: LaneKind;
  /** 粒子 1 個が表すリクエストレート (件/秒)。**Aurora 側と同じ値が渡ってくる**。 */
  readonly requestsPerParticle: number;
  /** 用意する粒子の上限。**リクエスト数ではない**。 */
  readonly maxParticles?: number;
}

/** 飛行中 (受理予定) の色。 */
const FLYING = [0.35, 0.85, 1] as const;
/** 弾かれた粒子の色。DynamoDB の壊れ方は「待たせる」ではなく「拒否する」。 */
const REJECTED = [1, 0.24, 0.16] as const;

const SCATTER_SECONDS = 0.9;
const GRAVITY = 9.8;

/**
 * リクエストを粒子として流す。
 *
 * ## 全リクエストは描かない
 *
 * 30,000 req/s を粒子 1 個ずつ描いたら即死する。
 * 上限数を `partitionWeights` に比例して各柱へ配り、
 * **統計値は正確なまま、絵だけ間引く**。
 * これは M1 から一貫した方針（PLAN.md「なぜ tick ベースのハイブリッドか」）。
 *
 * ## 実際に描く本数は共有の縮尺で決まる（M3 で変えた点）
 *
 * 以前は負荷に関わらず常に上限いっぱいを流していた。Aurora を並置すると、
 * それでは「同じ量を流している」が絵で確かめられない —
 * 片方が本数固定なら、両者の粒子の密度が一致するのは偶然でしかなくなる。
 * `requestsPerParticle` は共有の負荷ダイヤルから導かれた値がそのまま渡ってくるので、
 * **両者の本数が一致することは構造的に保証される**。
 *
 * ## 弾かれた粒子は赤く散る
 *
 * 「拒否」が目に見えることが重要。M3 で Aurora（詰まって列を成す）と
 * 並べたとき、壊れ方の非対称性がそのまま絵の違いになる。
 *
 * 受理か拒否かは、粒子が発射される瞬間にそのパーティションのスロットル率で抽選する。
 * 乱数は Core の seed 付き Rng を通す（Math.random を使わない、という Core の作法を View でも守る）。
 * ただし粒子はシミュレーションに一切影響しない。あくまで統計の表現である。
 */
export function RequestParticles({
  session,
  lane,
  requestsPerParticle,
  maxParticles = PARTICLE_BUDGET,
}: RequestParticlesProps): JSX.Element {
  const pointsRef = useRef<Points>(null);
  const count = session.table.partitionCount;
  const columnPositions = useMemo(() => gridPositions(count), [count]);

  const state = useMemo(() => {
    const positions = new Float32Array(maxParticles * 3);
    const colors = new Float32Array(maxParticles * 3);
    const partitionOf = new Int32Array(maxParticles);
    const progress = new Float32Array(maxParticles);
    const speed = new Float32Array(maxParticles);
    const scatterLife = new Float32Array(maxParticles);
    const velocity = new Float32Array(maxParticles * 3);
    const jitter = new Float32Array(maxParticles * 2);
    // 配分されなかった粒子 (重みが 0 のパーティションしか無い退化ケース) は、
    // 原点に置いたままだと空中の一点として描かれるので画面外へ退避させる。
    for (let i = 0; i < maxParticles; i += 1) positions[i * 3 + 1] = -50;

    // 重みに比例した配分。合計が maxParticles にぴったり一致する（余った粒子が出ない）。
    const counts = allocateByWeight(session.table.partitionWeights, maxParticles);
    const rng = new Rng(0x7e44a1);

    const assignment: number[] = [];
    for (let partition = 0; partition < counts.length; partition += 1) {
      for (let k = 0; k < (counts[partition] ?? 0); k += 1) assignment.push(partition);
    }
    // ⚠️ 並びを混ぜてから配る。配分の順番のまま並べると、負荷を下げて
    // 先頭の何本かだけを描いたとき**若い番号のパーティションにだけ粒子が集まる**。
    // 混ぜておけば、先頭を何本取っても重み分布の偏りのないサンプルになる。
    for (let i = assignment.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng.next() * (i + 1));
      const a = assignment[i] ?? 0;
      assignment[i] = assignment[j] ?? 0;
      assignment[j] = a;
    }

    let cursor = 0;
    for (; cursor < assignment.length && cursor < maxParticles; cursor += 1) {
      partitionOf[cursor] = assignment[cursor] ?? 0;
      // 初期位相をばらけさせないと、全粒子が同時に着弾して脈打って見える。
      progress[cursor] = rng.next();
      speed[cursor] = rng.nextInRange(0.45, 1.05);
      // 発射点をばらけさせる。同じ柱へ向かう粒子が多いほど経路が重なり、
      // ばらつきが小さいと「1 本の直線」に見えてしまう（単一ホットキーで顕著）。
      const radius = Math.sqrt(rng.next()) * 2.4;
      const angle = rng.nextInRange(0, Math.PI * 2);
      jitter[cursor * 2] = Math.cos(angle) * radius;
      jitter[cursor * 2 + 1] = Math.sin(angle) * radius;
    }

    return {
      positions,
      colors,
      partitionOf,
      progress,
      speed,
      scatterLife,
      velocity,
      jitter,
      rng,
      // 配分に使ったのは cursor 個まで。重みが 0 のパーティションしか無い場合に備える。
      active: cursor,
    };
  }, [session, maxParticles, count]);

  const positionsRef = useRef<BufferAttribute>(null);
  const colorsRef = useRef<BufferAttribute>(null);

  useFrame((_, delta) => {
    const points = pointsRef.current;
    const positionAttr = positionsRef.current;
    const colorAttr = colorsRef.current;
    if (points === null || positionAttr === null || colorAttr === null) return;

    const dt = Math.min(delta, 0.1); // タブ復帰時に粒子が瞬間移動しないよう頭を押さえる
    const info = session.table.lanes[lane];
    const laneTick = session.latest?.[lane];
    const { positions: pos, colors, partitionOf, progress, speed, scatterLife, velocity, jitter, rng } =
      state;

    // 共有の縮尺で決まる本数だけを流す。Aurora 側と同じ関数・同じ縮尺なので、
    // 同じ負荷なら本数が一致する。
    const active = Math.min(
      state.active,
      particleCount(laneTick?.demandedRequestsPerSec ?? 0, requestsPerParticle),
    );

    for (let i = 0; i < state.active; i += 1) {
      const partition = partitionOf[i] ?? 0;

      // 縮尺の外にいる粒子は描かない。負荷を下げれば流れが細くなる。
      if (i >= active && (scatterLife[i] ?? 0) <= 0) {
        pos[i * 3 + 1] = -50;
        colors[i * 3] = 0;
        colors[i * 3 + 1] = 0;
        colors[i * 3 + 2] = 0;
        continue;
      }

      const target = columnPositions[partition];
      if (target === undefined) continue;

      const tick = laneTick?.partitions[partition];
      const demanded = tick?.demandedUnitsPerSec ?? 0;
      const topY = columnHeight(demanded, info.hardCapUnitsPerSec);
      const i3 = i * 3;

      if (scatterLife[i] !== undefined && (scatterLife[i] ?? 0) > 0) {
        // 弾かれた後: 放物線を描いて散る
        const life = (scatterLife[i] ?? 0) - dt;
        scatterLife[i] = life;
        velocity[i3 + 1] = (velocity[i3 + 1] ?? 0) - GRAVITY * dt;
        pos[i3] = (pos[i3] ?? 0) + (velocity[i3] ?? 0) * dt;
        pos[i3 + 1] = (pos[i3 + 1] ?? 0) + (velocity[i3 + 1] ?? 0) * dt;
        pos[i3 + 2] = (pos[i3 + 2] ?? 0) + (velocity[i3 + 2] ?? 0) * dt;
        const fade = Math.max(0, life / SCATTER_SECONDS);
        colors[i3] = REJECTED[0] * fade;
        colors[i3 + 1] = REJECTED[1] * fade;
        colors[i3 + 2] = REJECTED[2] * fade;
        if (life <= 0) progress[i] = 0;
        continue;
      }

      // 需要が無いパーティションには粒子を流さない（画面外へ退避させる）。
      if (demanded <= 0) {
        pos[i3 + 1] = -50;
        colors[i3] = 0;
        colors[i3 + 1] = 0;
        colors[i3 + 2] = 0;
        continue;
      }

      const t = (progress[i] ?? 0) + (speed[i] ?? 0.7) * dt;
      if (t >= 1) {
        // 着弾。ここで初めて受理か拒否かが分かる。
        if (rng.next() < partitionThrottleRate(tick)) {
          scatterLife[i] = SCATTER_SECONDS;
          velocity[i3] = rng.nextInRange(-2.2, 2.2);
          velocity[i3 + 1] = rng.nextInRange(1.5, 4);
          velocity[i3 + 2] = rng.nextInRange(-2.2, 2.2);
          pos[i3] = target.x;
          pos[i3 + 1] = topY;
          pos[i3 + 2] = target.z;
          continue;
        }
        progress[i] = t - 1; // 受理された粒子は柱に吸い込まれ、次のリクエストとして戻ってくる
        continue;
      }
      progress[i] = t;

      const sourceX = target.x * 0.15 + (jitter[i * 2] ?? 0);
      const sourceZ = target.z * 0.15 + (jitter[i * 2 + 1] ?? 0);
      // 発射点は必ず柱の頂上より上に取る。固定の高さにすると、
      // 上限を大きく超えた柱では頂上が発射点に並び、粒子が水平に流れて「降ってくる」感が消える。
      const sourceY = Math.max(SOURCE_HEIGHT, topY + 2.5);
      pos[i3] = sourceX + (target.x - sourceX) * t;
      pos[i3 + 1] = sourceY + (topY - sourceY) * t;
      pos[i3 + 2] = sourceZ + (target.z - sourceZ) * t;
      colors[i3] = FLYING[0];
      colors[i3 + 1] = FLYING[1];
      colors[i3 + 2] = FLYING[2];
    }

    positionAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  });

  return (
    <points ref={pointsRef} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute
          ref={positionsRef}
          attach="attributes-position"
          args={[state.positions, 3]}
        />
        <bufferAttribute ref={colorsRef} attach="attributes-color" args={[state.colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.15}
        sizeAttenuation
        vertexColors
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  );
}
