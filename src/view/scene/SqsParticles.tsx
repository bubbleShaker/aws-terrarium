import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { JSX } from 'react';
import type { BufferAttribute, Points } from 'three';
import type { DrivenSqsSession } from '../../core/scenario/driver.js';
import { Rng } from '../../core/sim/rng.js';
import {
  LANE_WIDTH,
  PARTICLE_BUDGET,
  SOURCE_HEIGHT,
  backlogLaneLength,
  particleCount,
  sqsSiteMetrics,
} from '../layout.js';

interface SqsParticlesProps {
  readonly session: DrivenSqsSession;
  /** 粒子 1 個が表すリクエストレート (件/秒)。**3 サービスとも同じ値が渡ってくる**。 */
  readonly requestsPerParticle: number;
}

/** 列へ向かって降下中。 */
const FLYING = [0.35, 0.85, 1] as const;
/** 列に並んで consumer へ進んでいる。 */
const QUEUED = [0.42, 0.68, 0.92] as const;
/** consumer に捌かれた瞬間。 */
const CONSUMED = [0.37, 0.95, 0.75] as const;

/** 消えていく演出にかける時間 (秒)。 */
const FADE_SECONDS = 0.5;
/** 捌かれた瞬間の点滅にかける時間 (秒)。 */
const CONSUMED_SECONDS = 0.25;

/**
 * 列を端から端まで進むのにかける時間の下限・上限 (秒)。
 *
 * ⚠️ `endToEndLatencySeconds` をそのまま使ってはいけない。
 * バックログ 30,000 件では 75 秒に達し、粒子は完全に静止して見える。
 * レーンの長さが対数で圧縮されているので、**進む時間も同じように圧縮する**
 * （長さと時間で別々の縮尺を使うと、速さが件数と無関係な値に化ける）。
 */
const MIN_TRANSIT_SECONDS = 1.2;
const MAX_TRANSIT_SECONDS = 9;

/**
 * SQS のキューへ流れ込むメッセージを粒子として描く。
 *
 * ## 3 サービスを並べたとき、ここだけ絵が「壊れない」
 *
 * | | 弾かれる場所 | 弾かれる条件 |
 * |---|---|---|
 * | DynamoDB | 柱の頂上 | 需要がパーティションの上限を越えた瞬間 |
 * | Aurora | 待合室の入口 | 1,000 席が埋まりきってから |
 * | **SQS** | **無い** | **どれだけ流しても起きない** |
 *
 * ここに拒否の抽選が 1 つも無いことがモデルの主張そのものである
 * （Core 側でも `SqsQueue.step()` の受付側に `Math.min` が 1 つも無い）。
 * 隣で赤い粒子が散っている横で、**こちらは何事も無く流れ続ける**のが見せたい絵である。
 *
 * ## 到着は尾へ、消化は先頭で
 *
 * 降ってきた粒子は**列の尾**（いちばん奥）に着地し、手前の consumer へ向かって進む。
 * FIFO なので、いま届いたメッセージが捌かれるのは**いま並んでいる全員の後**である。
 * 列が伸びるほど降下地点が遠のいていくことが、
 * 「送った瞬間は成功したのに、処理されるのはずっと後」を形にしている
 * （`sendLatencyMs` はバックログが何件でも動かない）。
 *
 * ## ⚠️ 期限切れは赤くしない
 *
 * 先頭に着いた粒子は、捌かれるか**期限切れで消えるか**のどちらかになる。
 * 後者を赤くしたり弾き飛ばしたりすると、それは他の 2 つと同じ「拒否」に見える。
 * SQS の消失はエラーを伴わない — 誰にも通知されず、CloudWatch のエラー率にも出ない。
 * **その場で静かに薄れて消える**のが正しい表現である。
 */
export function SqsParticles({ session, requestsPerParticle }: SqsParticlesProps): JSX.Element {
  const pointsRef = useRef<Points>(null);
  const positionsRef = useRef<BufferAttribute>(null);
  const colorsRef = useRef<BufferAttribute>(null);

  const headZ = useMemo(() => sqsSiteMetrics(0).headZ, []);

  const state = useMemo(() => {
    const positions = new Float32Array(PARTICLE_BUDGET * 3);
    const colors = new Float32Array(PARTICLE_BUDGET * 3);
    /** 0..1 が降下、1..2 が列の横断。2 に届いたら先頭で結末が決まる。 */
    const progress = new Float32Array(PARTICLE_BUDGET);
    const fallSpeed = new Float32Array(PARTICLE_BUDGET);
    /** 消えていく残り時間。期限切れと、捌かれた瞬間の両方で使う。 */
    const fadeLife = new Float32Array(PARTICLE_BUDGET);
    /** 消え方。0 = 捌かれた（緑に光る）/ 1 = 期限切れ（色を変えず薄れる）。 */
    const fadeKind = new Float32Array(PARTICLE_BUDGET);
    /** 列のどの筋に並ぶか (-0.5..0.5)。1 本の線に見えないようにする。 */
    const laneOffset = new Float32Array(PARTICLE_BUDGET);
    const jitter = new Float32Array(PARTICLE_BUDGET * 2);
    for (let i = 0; i < PARTICLE_BUDGET; i += 1) positions[i * 3 + 1] = -50;

    // 乱数は Core の seed 付き Rng を通す（View でも Math.random を使わない作法）。
    const rng = new Rng(0x5a3f11);
    for (let i = 0; i < PARTICLE_BUDGET; i += 1) {
      progress[i] = rng.nextInRange(0, 2);
      fallSpeed[i] = rng.nextInRange(0.45, 1.05);
      laneOffset[i] = rng.next() - 0.5;
      const radius = Math.sqrt(rng.next()) * 1.4;
      const angle = rng.nextInRange(0, Math.PI * 2);
      jitter[i * 2] = Math.cos(angle) * radius;
      jitter[i * 2 + 1] = Math.sin(angle) * radius;
    }

    return { positions, colors, progress, fallSpeed, fadeLife, fadeKind, laneOffset, jitter, rng };
  }, []);

  useFrame((_, delta) => {
    const points = pointsRef.current;
    const positionAttr = positionsRef.current;
    const colorAttr = colorsRef.current;
    if (points === null || positionAttr === null || colorAttr === null) return;

    const dt = Math.min(delta, 0.1); // タブ復帰時に瞬間移動しないよう頭を押さえる
    const latest = session.latest;

    // 列の長さ。粒子の着地点はここで決まるので、レーンと同じ関数から出す
    // （別々に計算すると、粒子が板の上ではなく虚空に降り始める）。
    const laneLength = backlogLaneLength(latest?.backlogVisible ?? session.queue.queueDepth);
    const tailZ = headZ - laneLength;

    // 列を渡りきる時間。長さが対数で圧縮されているので、時間も長さから出す。
    const transitSeconds = Math.min(
      MAX_TRANSIT_SECONDS,
      Math.max(MIN_TRANSIT_SECONDS, MIN_TRANSIT_SECONDS + laneLength * 0.5),
    );
    const transitSpeed = 1 / transitSeconds;

    // 先頭に着いた粒子が期限切れになる割合。
    // ⚠️ ここは Core が出した実測レートの比であって、View の演出ではない。
    // 消え始めていなければ 0 のままで、粒子は 1 つも消えない。
    const leaving = (latest?.consumedMessagesPerSec ?? 0) + (latest?.expiredMessagesPerSec ?? 0);
    const expireRate = leaving > 0 ? Math.min(1, (latest?.expiredMessagesPerSec ?? 0) / leaving) : 0;

    // 本数はダイヤルが出している需要から。**受理量ではない**が、SQS では両者が常に一致する
    // （入口に壁が無いので `enqueued === demanded`）。それでも需要側を読むのは、
    // 3 サービスで同じ量を見ていることを構造で揃えておくため。
    const active = particleCount(latest?.demandedMessagesPerSec ?? 0, requestsPerParticle);
    const { positions: pos, colors, progress, fallSpeed, fadeLife, fadeKind, laneOffset, jitter, rng } =
      state;

    for (let i = 0; i < PARTICLE_BUDGET; i += 1) {
      const i3 = i * 3;

      // 縮尺の外にいる粒子は描かない。負荷を下げれば流れが細くなる。
      if (i >= active && (fadeLife[i] ?? 0) <= 0) {
        pos[i3 + 1] = -50;
        colors[i3] = 0;
        colors[i3 + 1] = 0;
        colors[i3 + 2] = 0;
        continue;
      }

      if ((fadeLife[i] ?? 0) > 0) {
        // ── 結末: その場で薄れる ──
        // 期限切れでも飛ばさず、色も変えない。**気づかれずに消える**のが SQS の消失である。
        const expired = (fadeKind[i] ?? 0) > 0.5;
        const span = expired ? FADE_SECONDS : CONSUMED_SECONDS;
        const life = (fadeLife[i] ?? 0) - dt;
        fadeLife[i] = life;
        const fade = Math.max(0, life / span);
        const tint = expired ? QUEUED : CONSUMED;
        colors[i3] = tint[0] * fade;
        colors[i3 + 1] = tint[1] * fade;
        colors[i3 + 2] = tint[2] * fade;
        if (life <= 0) progress[i] = 0;
        continue;
      }

      let t = progress[i] ?? 0;
      const lane = (laneOffset[i] ?? 0) * LANE_WIDTH * 0.8;

      if (t < 1) {
        // ── 降下: 源から**列の尾**へ ──
        // 着地点が奥へ遠のいていくこと自体が、バックログの深さである。
        t += (fallSpeed[i] ?? 0.7) * dt;
        progress[i] = t;

        const sourceX = lane * 0.2 + (jitter[i * 2] ?? 0);
        const sourceZ = tailZ + (jitter[i * 2 + 1] ?? 0);
        const fall = Math.min(1, t);
        pos[i3] = sourceX + (lane - sourceX) * fall;
        pos[i3 + 1] = SOURCE_HEIGHT + (0.22 - SOURCE_HEIGHT) * fall;
        pos[i3 + 2] = sourceZ + (tailZ - sourceZ) * fall;
        colors[i3] = FLYING[0];
        colors[i3 + 1] = FLYING[1];
        colors[i3 + 2] = FLYING[2];
        continue;
      }

      // ── 横断: 尾から先頭へ。FIFO なので追い越しは起きない ──
      t += transitSpeed * dt;
      if (t >= 2) {
        // 先頭に着いた。ここで初めて結末が決まる — **捌かれるか、消えるか**。
        // どちらであっても、producer には何も返らない。
        const expired = rng.next() < expireRate;
        fadeKind[i] = expired ? 1 : 0;
        fadeLife[i] = expired ? FADE_SECONDS : CONSUMED_SECONDS;
        pos[i3] = lane;
        pos[i3 + 1] = 0.22;
        pos[i3 + 2] = headZ;
        continue;
      }
      progress[i] = t;

      const crossed = t - 1;
      pos[i3] = lane;
      pos[i3 + 1] = 0.22;
      pos[i3 + 2] = tailZ + (headZ - tailZ) * crossed;
      colors[i3] = QUEUED[0];
      colors[i3 + 1] = QUEUED[1];
      colors[i3 + 2] = QUEUED[2];
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
