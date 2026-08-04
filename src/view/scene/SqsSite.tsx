import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { BoxGeometry, Color, Float32BufferAttribute, PlaneGeometry, type Mesh } from 'three';
import type { DrivenSqsSession } from '../../core/scenario/driver.js';
import {
  AGE_BAR_OFFSET_X,
  AGE_BAR_WIDTH,
  CONSUMER_BANK_DEPTH,
  CONSUMER_BANK_HEIGHT,
  CONSUMER_BANK_WIDTH,
  HEIGHT_AT_HARD_CAP,
  LANE_WIDTH,
  ageBarHeight,
  backlogLaneLength,
  damp,
  sqsSiteMetrics,
} from '../layout.js';
import {
  BACKGROUND,
  CONSUMER_BUSY,
  CONSUMER_IDLE,
  CONSUMER_LIMITED,
  LANE_BODY,
  ageColor,
} from '../palette.js';

interface SqsSiteProps {
  readonly session: DrivenSqsSession;
}

/** レーンを刻む数。尾へ向かう不透明度のグラデーションの滑らかさを決める。 */
const LANE_SEGMENTS = 48;
/** レーンの厚み。地面から浮かせる高さも兼ねる。 */
const LANE_LIFT = 0.02;

/**
 * SQS のキュー 1 本ぶんの設備。**器が無いことを、器を描かずに見せる**。
 *
 * ```
 *          ┃ ← 年齢の縦棒 (ApproximateAgeOfOldestMessage)
 *   ╔════╗ ┃
 *   ║ ⇩  ║ ═══════════════════···   ← レーン。尾は霧へ溶けて終わらない
 *   ╚════╝ ↑                    ↑
 *  consumer 列の先頭            奥へ伸びる (-z)
 * ```
 *
 * ## DynamoDB / Aurora と決定的に違うところ
 *
 * | | 何が壁を語るか | 過負荷の絵 |
 * |---|---|---|
 * | DynamoDB | 基準面を突き抜けた柱 | 頂上で赤く散る |
 * | Aurora | 有限の席 (`max_connections`) | 席が埋まりきって入口で弾かれる |
 * | **SQS** | **無い** | **レーンが伸びるだけ。色すら変わらない** |
 *
 * Aurora の待合室を流用しなかった理由がここにある。席は `max_connections` という
 * **有限の器**を描いた物であって、器を描いた時点で「無制限」が消える
 * （寸法の破綻については PLAN.md「M4-2 の壁 2」）。
 *
 * ## 唯一の警報だけが別の軸に立つ
 *
 * 年齢の縦棒はレーンと**直交**させてある。M4 の看板は
 * 「**長さが減っているのに年齢は伸びる**」— 負荷を安全域へ下げた直後、
 * 先頭はまだ過負荷の層に居るので年齢は伸び続ける — なので、
 * 年齢をレーンの長さや色に乗せると、この主役の現象が同じ軸に潰れて消える。
 *
 * ## ここは何のロジックも持たない
 *
 * 長さも高さも `layout.ts` の純粋関数に写させ、値は `session.latest` を直読みする
 * （`PartitionColumns` / `AuroraSite` と同じ方針）。
 */
export function SqsSite({ session }: SqsSiteProps): JSX.Element {
  const queue = session.queue;

  const laneRef = useRef<Mesh>(null);
  const bankRef = useRef<Mesh>(null);
  const ageBarRef = useRef<Mesh>(null);

  const scratch = useMemo(() => ({ color: new Color() }), []);

  /**
   * 列の先頭の z。**バックログの件数に依らない**（伸びるのは尾だけ）ので、
   * 引数は何を渡しても同じ値が返る。0 を渡しているのは「件数に依らない」ことの表明。
   *
   * 尾の位置は毎フレーム変わるため、`sqsSiteMetrics` の `tailZ` / `laneZ` は使わない
   * （こちらは追従を挟んだ表示中の長さから出す。tick の跳ねをそのまま入れると列が痙攣する）。
   */
  const headZ = useMemo(() => sqsSiteMetrics(0).headZ, []);

  /**
   * レーンの板。**尾へ向かって背景色へ沈む**グラデーションを 1 回だけ焼き込む。
   *
   * ⚠️ 溶かすのはシーンの霧ではなくここ（M4-2a の申し送り 1）。
   * `fogRange` は最奥の敷地が沈まないよう `far` を押し出すが、three.js の fog は
   * シーン全体へ一律にかかるので、押し出すと尾の溶け方まで一緒に弱まる
   * （30,000 件で 0.80 → 0.41）。霧には「敷地を沈ませない」役に徹してもらい、
   * 「端が無い」はレーン自身の材質で語る。
   *
   * 透明度ではなく背景色への lerp にしてあるのは、透過を重ねると
   * 地面のグリッド線がレーンを透かして見え、**列が半透明の膜に見える**ため。
   * 沈む先は空の色そのものなので、見た目は「溶けて消える」と同じになる。
   */
  const laneGeometry = useMemo(() => {
    // 長さ 1 で作り、`scale` で伸ばす。件数が変わるたびにジオメトリを作り直すと、
    // 毎フレーム 48 セグメントぶんの頂点を GPU へ送り直すことになる。
    const geometry = new PlaneGeometry(LANE_WIDTH, 1, 1, LANE_SEGMENTS);
    const position = geometry.attributes.position;
    if (position === undefined) return geometry;

    const colors = new Float32Array(position.count * 3);
    const head = new Color(LANE_BODY);
    const tail = new Color(BACKGROUND);
    const mixed = new Color();
    for (let i = 0; i < position.count; i += 1) {
      // 回転 (-90°) 後、ローカル +y が奥 (-z) を向く。y = +0.5 が尾。
      const towardTail = position.getY(i) + 0.5;
      // 手前 2 割は素の色のまま。先頭（捌かれ、期限切れで消える場所）が
      // 薄まると、SQS でいちばん見せたい瞬間が読めなくなる。
      const fade = Math.max(0, (towardTail - 0.2) / 0.8);
      mixed.copy(head).lerp(tail, fade);
      colors[i * 3] = mixed.r;
      colors[i * 3 + 1] = mixed.g;
      colors[i * 3 + 2] = mixed.b;
    }
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return geometry;
  }, []);

  // R3F が破棄してくれるのは JSX で宣言したぶんだけ。自分で作った物は自分で捨てる。
  const bankBox = useMemo(
    () => new BoxGeometry(CONSUMER_BANK_WIDTH, CONSUMER_BANK_HEIGHT, CONSUMER_BANK_DEPTH),
    [],
  );
  /** 保持期間 100% の目印。JSX に直接書くと毎レンダー新しいジオメトリが積み上がる。 */
  const retentionMark = useMemo(
    () => new BoxGeometry(AGE_BAR_WIDTH * 1.8, 0.001, AGE_BAR_WIDTH * 1.8),
    [],
  );
  useEffect(() => () => laneGeometry.dispose(), [laneGeometry]);
  useEffect(() => () => bankBox.dispose(), [bankBox]);
  useEffect(() => () => retentionMark.dispose(), [retentionMark]);

  // 表示中の長さ・高さ。tick ごとに跳ねる値をそのまま入れると列が痙攣するので追従させる。
  const smoothed = useRef({ laneLength: 0, ageHeight: 0 });

  useFrame((_, delta) => {
    const lane = laneRef.current;
    const bank = bankRef.current;
    const ageBar = ageBarRef.current;
    if (lane === null || bank === null || ageBar === null) return;

    const latest = session.latest;
    const { color } = scratch;

    // ── レーン: 列に並んでいる件数だけ奥へ伸びる ──
    // ⚠️ `queueDepth` ではなく `backlogVisible` を使う。in-flight は consumer が
    // 掴んで処理している最中のもので、もう列には並んでいない
    // （CloudWatch でも `ApproximateNumberOfMessagesVisible` と
    // `ApproximateNumberOfMessagesNotVisible` は別の指標である）。
    const backlog = latest?.backlogVisible ?? queue.queueDepth;
    const laneLength = damp(smoothed.current.laneLength, backlogLaneLength(backlog), 6, delta);
    smoothed.current.laneLength = laneLength;

    lane.scale.set(1, Math.max(1e-4, laneLength), 1);
    lane.position.set(0, LANE_LIFT, headZ - laneLength / 2);
    lane.visible = laneLength > 1e-3;

    // ── consumer: 稼働率で光る。**本数は描かない**（本数は壁ではない） ──
    const capacity = queue.capacityPerSec;
    const busyRatio =
      capacity > 0 ? Math.min(1, (latest?.consumedMessagesPerSec ?? 0) / capacity) : 0;
    // in-flight 上限に当たっている間は、consumer を増やしても消化レートが伸びない。
    // SQS で唯一の壁なので、そこだけは色を変えて知らせる。
    const busy = queue.inFlightLimited ? CONSUMER_LIMITED : CONSUMER_BUSY;
    paint(bank, color.copy(CONSUMER_IDLE).lerp(busy, busyRatio));

    // ── 年齢の縦棒: 唯一の警報 ──
    const ageHeight = damp(
      smoothed.current.ageHeight,
      ageBarHeight(latest?.oldestMessageAgeSeconds ?? 0, queue.messageRetentionSeconds),
      6,
      delta,
    );
    smoothed.current.ageHeight = ageHeight;
    // ⚠️ 高さは `ageBarHeight` が保持期間 100% で頭打ちにしている。柱と違って
    // **決して突き抜けない** — 保持期間を超えたメッセージはもう存在しないからである。
    ageBar.scale.set(1, Math.max(1e-4, ageHeight), 1);
    ageBar.position.set(AGE_BAR_OFFSET_X, ageHeight / 2, headZ);
    paint(ageBar, ageColor(latest?.retentionUtilization ?? 0, color));
  });

  return (
    <group>
      {/* consumer の設備。列の先頭に立ち、ここで捌かれ、ここで期限切れが起きる。 */}
      <mesh ref={bankRef} geometry={bankBox} position={[0, CONSUMER_BANK_HEIGHT / 2, 0]}>
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <lineSegments position={[0, CONSUMER_BANK_HEIGHT / 2, 0]}>
        <edgesGeometry args={[bankBox]} />
        <lineBasicMaterial color="#7fa6d8" transparent opacity={0.7} />
      </lineSegments>

      {/*
        レーン本体。長さだけが件数を語り、**色は何件でも変わらない**（`LANE_BODY` の解説）。
        `frustumCulled` を切るのは、長さが毎フレーム変わる物の境界球が当てにならないため。
      */}
      <mesh
        ref={laneRef}
        geometry={laneGeometry}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
      >
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>

      {/* 年齢の縦棒。レーンの脇に、レーンと直交して立つ。 */}
      <mesh ref={ageBarRef} frustumCulled={false}>
        <boxGeometry args={[AGE_BAR_WIDTH, 1, AGE_BAR_WIDTH]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>

      {/*
        保持期間 100% の目印。DynamoDB の物理上限の基準面と**同じ高さ**にしてあるので、
        3 つの敷地で「この高さが壁」が揃う。
        ただしこちらの壁は越えられるのではなく、**越える前に消える**。
      */}
      <lineSegments position={[AGE_BAR_OFFSET_X, HEIGHT_AT_HARD_CAP, headZ]}>
        <edgesGeometry args={[retentionMark]} />
        <lineBasicMaterial color="#c04ee0" transparent opacity={0.55} />
      </lineSegments>
    </group>
  );
}

/** マテリアルの色を差し替える。1 枚しかない物に instancing は要らない。 */
function paint(mesh: Mesh, color: Color): void {
  const material = mesh.material;
  if (!Array.isArray(material) && 'color' in material) (material.color as Color).copy(color);
}
