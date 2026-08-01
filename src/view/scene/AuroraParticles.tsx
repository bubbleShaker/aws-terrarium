import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { JSX } from 'react';
import type { BufferAttribute, Points } from 'three';
import type { DrivenAuroraSession } from '../../core/scenario/driver.js';
import { Rng } from '../../core/sim/rng.js';
import {
  PARTICLE_BUDGET,
  SOURCE_HEIGHT,
  auroraSiteMetrics,
  particleCount,
} from '../layout.js';

interface AuroraParticlesProps {
  readonly session: DrivenAuroraSession;
  /** 粒子 1 個が表すリクエストレート (件/秒)。**DynamoDB 側と同じ値が渡ってくる**。 */
  readonly requestsPerParticle: number;
}

/** 待合室へ向かって降下中。 */
const FLYING = [0.35, 0.85, 1] as const;
/** 列に並んで writer へ進んでいる。待つほど濃くなるので、値は待ち時間で作る。 */
const QUEUED_FAST = [0.37, 0.95, 0.75] as const;
const QUEUED_SLOW = [1, 0.72, 0.24] as const;
/** 壁B で弾かれた。`Too many connections`。 */
const REJECTED = [1, 0.24, 0.16] as const;

const SCATTER_SECONDS = 0.9;
const GRAVITY = 9.8;
/**
 * 待合室の横断にかける時間の下限・上限 (秒)。
 *
 * レイテンシをそのまま横断時間にすると、5ms では 1 フレームで通過して見えず、
 * メタステーブル状態の数十秒では止まって見える。
 * **どちらも「速さの違い」として読めなくなる**ので、目で追える範囲へ収める。
 */
const MIN_CROSSING_SECONDS = 0.25;
const MAX_CROSSING_SECONDS = 6;

/**
 * Aurora へ流れ込むリクエストを粒子として描く。
 *
 * ## DynamoDB 側との違いが、そのまま壊れ方の違いになる
 *
 * | | DynamoDB (`RequestParticles`) | Aurora (ここ) |
 * |---|---|---|
 * | 弾かれる場所 | **柱の頂上**。着弾した瞬間 | **待合室の入口**。並ぶ場所が無くなってから |
 * | 弾かれるまで | 常に即座 | 待合室 1,000 席が埋まるまで**一度も弾かれない** |
 * | 受理された粒子 | 柱に吸い込まれて即消える | **待合室を横断する。その所要時間がレイテンシ** |
 *
 * 横断時間をレイテンシに結び付けているのが肝である。
 * 数字を読まなくても、Aurora の粒子が這っている間に DynamoDB の粒子が
 * 何往復もしているのが見えれば、それが「レイテンシだけ桁違い」の中身である。
 *
 * ## 粒子の本数は共有の縮尺で決まる
 *
 * `requestsPerParticle` は共有の負荷ダイヤルから導かれた値がそのまま渡ってくる。
 * 本数を決めるのに使うのは **`demandedRequestsPerSec`（負荷ダイヤルが出している素の需要）**であって、
 * `offeredRequestsPerSec`（再送を含む実際の到着量）ではない。
 *
 * ⚠️ ここを到着量にすると、再送を入れた瞬間に Aurora 側だけ粒子が増え、
 * 「同じ量を流している」が絵の上で崩れる。増幅は Aurora 自身が生んだものであって
 * ダイヤルが流したものではないので、流れの太さに混ぜない
 * （増幅の大きさは HUD の `retriedRequestsPerSec` が数字で語る）。
 *
 * これで、負荷が 1 本のレーンに乗っている限り
 * **DynamoDB 側と粒子の本数が一致する**（`test/viewLayout.test.ts` が driver を回して固定している）。
 * 両レーンに値が入っているときは、DynamoDB がフォーカス中の 1 レーンしか描かないぶん少なくなる。
 *
 * 粒子はシミュレーションに一切影響しない。あくまで統計の表現である。
 */
export function AuroraParticles({ session, requestsPerParticle }: AuroraParticlesProps): JSX.Element {
  const pointsRef = useRef<Points>(null);
  const positionsRef = useRef<BufferAttribute>(null);
  const colorsRef = useRef<BufferAttribute>(null);

  const metrics = useMemo(
    () => auroraSiteMetrics(session.writer.maxConnections),
    [session.writer.maxConnections],
  );

  const state = useMemo(() => {
    const positions = new Float32Array(PARTICLE_BUDGET * 3);
    const colors = new Float32Array(PARTICLE_BUDGET * 3);
    /** 0..1 が降下、1..2 が待合室の横断。2 に届いたら次の周回へ。 */
    const progress = new Float32Array(PARTICLE_BUDGET);
    const fallSpeed = new Float32Array(PARTICLE_BUDGET);
    const scatterLife = new Float32Array(PARTICLE_BUDGET);
    const velocity = new Float32Array(PARTICLE_BUDGET * 3);
    /** 待合室のどの列に並ぶか (-0.5..0.5)。1 本の線に見えないようにする。 */
    const laneOffset = new Float32Array(PARTICLE_BUDGET);
    const jitter = new Float32Array(PARTICLE_BUDGET * 2);
    for (let i = 0; i < PARTICLE_BUDGET; i += 1) positions[i * 3 + 1] = -50;

    // 乱数は Core の seed 付き Rng を通す（Math.random を使わない、という作法を View でも守る）。
    const rng = new Rng(0x51d3a7);
    for (let i = 0; i < PARTICLE_BUDGET; i += 1) {
      progress[i] = rng.nextInRange(0, 2);
      fallSpeed[i] = rng.nextInRange(0.45, 1.05);
      laneOffset[i] = rng.next() - 0.5;
      const radius = Math.sqrt(rng.next()) * 1.6;
      const angle = rng.nextInRange(0, Math.PI * 2);
      jitter[i * 2] = Math.cos(angle) * radius;
      jitter[i * 2 + 1] = Math.sin(angle) * radius;
    }

    return { positions, colors, progress, fallSpeed, scatterLife, velocity, laneOffset, jitter, rng };
  }, []);

  useFrame((_, delta) => {
    const points = pointsRef.current;
    const positionAttr = positionsRef.current;
    const colorAttr = colorsRef.current;
    if (points === null || positionAttr === null || colorAttr === null) return;

    const dt = Math.min(delta, 0.1); // タブ復帰時に瞬間移動しないよう頭を押さえる
    const latest = session.latest;
    const offered = latest?.offeredRequestsPerSec ?? 0;
    // 拒否の抽選率。壁B があふれていない間は 0 のままで、粒子は 1 つも赤くならない。
    const rejectRate = offered > 0 ? Math.min(1, (latest?.rejectedRequestsPerSec ?? 0) / offered) : 0;
    const latencySeconds = latest?.latencySeconds ?? 0;
    const crossingSeconds = Math.min(
      MAX_CROSSING_SECONDS,
      Math.max(MIN_CROSSING_SECONDS, latencySeconds),
    );
    const crossingSpeed = 1 / crossingSeconds;
    // 待つほど濃い色にする。上限は横断時間と揃えておく（色と速さが同じ量を語る）。
    const waitMix = Math.min(1, latencySeconds / MAX_CROSSING_SECONDS);

    // ダイヤルが出している素の需要で本数を決める（再送は混ぜない。解説はこの関数の docstring）。
    const active = particleCount(latest?.demandedRequestsPerSec ?? 0, requestsPerParticle);
    const { positions: pos, colors, progress, fallSpeed, scatterLife, velocity, laneOffset, jitter, rng } =
      state;

    const entranceZ = metrics.entranceZ;
    const gateZ = metrics.gateZ;

    for (let i = 0; i < PARTICLE_BUDGET; i += 1) {
      const i3 = i * 3;

      // 縮尺の外にいる粒子は描かない。負荷を下げれば流れが細くなる。
      if (i >= active && (scatterLife[i] ?? 0) <= 0) {
        pos[i3 + 1] = -50;
        colors[i3] = 0;
        colors[i3 + 1] = 0;
        colors[i3 + 2] = 0;
        continue;
      }

      if ((scatterLife[i] ?? 0) > 0) {
        // 弾かれた後: 待合室の入口で放物線を描いて散る
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

      let t = progress[i] ?? 0;

      if (t < 1) {
        // ── 降下: 源から待合室の入口へ ──
        t += (fallSpeed[i] ?? 0.7) * dt;
        if (t >= 1) {
          // 入口に到着。ここで初めて「並べるか、弾かれるか」が決まる。
          // DynamoDB が柱の頂上で弾くのに対し、こちらは**待合室の入口**で弾く。
          if (rng.next() < rejectRate) {
            scatterLife[i] = SCATTER_SECONDS;
            velocity[i3] = rng.nextInRange(-1.8, 1.8);
            velocity[i3 + 1] = rng.nextInRange(1.5, 3.5);
            velocity[i3 + 2] = rng.nextInRange(0.5, 2.5);
            pos[i3] = (laneOffset[i] ?? 0) * metrics.roomWidth;
            pos[i3 + 1] = 0.35;
            pos[i3 + 2] = entranceZ;
            continue;
          }
        }
        progress[i] = t;

        const lane = (laneOffset[i] ?? 0) * metrics.roomWidth;
        const sourceX = lane * 0.2 + (jitter[i * 2] ?? 0);
        const sourceZ = entranceZ + (jitter[i * 2 + 1] ?? 0);
        const fall = Math.min(1, t);
        pos[i3] = sourceX + (lane - sourceX) * fall;
        pos[i3 + 1] = SOURCE_HEIGHT + (0.28 - SOURCE_HEIGHT) * fall;
        pos[i3 + 2] = sourceZ + (entranceZ - sourceZ) * fall;
        colors[i3] = FLYING[0];
        colors[i3 + 1] = FLYING[1];
        colors[i3 + 2] = FLYING[2];
        continue;
      }

      // ── 横断: 待合室の入口から窓口へ。**この所要時間がレイテンシ** ──
      t += crossingSpeed * dt;
      if (t >= 2) {
        progress[i] = 0; // 窓口で処理された。次のリクエストとして源へ戻る
        continue;
      }
      progress[i] = t;

      const crossed = t - 1;
      pos[i3] = (laneOffset[i] ?? 0) * metrics.roomWidth;
      pos[i3 + 1] = 0.28;
      pos[i3 + 2] = entranceZ + (gateZ - entranceZ) * crossed;
      colors[i3] = QUEUED_FAST[0] + (QUEUED_SLOW[0] - QUEUED_FAST[0]) * waitMix;
      colors[i3 + 1] = QUEUED_FAST[1] + (QUEUED_SLOW[1] - QUEUED_FAST[1]) * waitMix;
      colors[i3 + 2] = QUEUED_FAST[2] + (QUEUED_SLOW[2] - QUEUED_FAST[2]) * waitMix;
    }

    positionAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  });

  return (
    <points ref={pointsRef} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute ref={positionsRef} attach="attributes-position" args={[state.positions, 3]} />
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
