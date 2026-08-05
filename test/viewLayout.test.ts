import { describe, expect, it } from 'vitest';
import {
  AGE_BAR_OFFSET_X,
  CAMERA_FOV_DEGREES,
  CAMERA_TARGET_HEIGHT,
  COLUMN_SPACING,
  CONSUMER_BANK_DEPTH,
  CONSUMER_BANK_WIDTH,
  GROUND_CELL_SIZE,
  VISIBLE_WIDTH_FRACTION,
  HEIGHT_AT_HARD_CAP,
  LANE_WIDTH,
  PIPE_TOP,
  PARTICLE_BUDGET,
  REQUESTS_PER_SEAT,
  SEAT_SPACING,
  ageBarHeight,
  auroraSiteMetrics,
  backlogLaneLength,
  columnHeight,
  damp,
  distanceFromInitialCamera,
  fogRange,
  gridExtent,
  gridPositions,
  gridWidth,
  groundGrid,
  initialCameraPosition,
  particleCount,
  requestsPerParticle,
  roomWidth,
  seatCount,
  seatPositions,
  siteOrigins,
  siteSeparation,
  sqsSetback,
  sqsSiteMetrics,
  terrariumExtent,
  vcpuGatePositions,
} from '../src/view/layout.js';
import { AURORA_INSTANCE_CLASSES } from '../src/core/services/aurora/instanceClasses.js';
import { TerrariumDriver } from '../src/core/scenario/driver.js';
import { sameLoadEverywhere } from '../src/core/scenario/terrariumPresets.js';

/**
 * View 層の配置計算のテスト。
 *
 * 見た目の話に見えるが、`columnHeight` は
 * 「物理上限までは線形、超えた分は圧縮」という**教材の主張そのもの**を担っている。
 * ここが壊れると、ホットパーティションの異常さが絵の上で嘘になる。
 *
 * three.js に依存しないよう色 (palette.ts) と分けてあるので、Node 上でそのまま検証できる。
 */
describe('columnHeight', () => {
  it('物理上限ちょうどで基準面の高さになる', () => {
    expect(columnHeight(1_000, 1_000)).toBe(HEIGHT_AT_HARD_CAP);
    expect(columnHeight(3_000, 3_000)).toBe(HEIGHT_AT_HARD_CAP);
  });

  it('上限までは需要に比例する', () => {
    expect(columnHeight(500, 1_000)).toBeCloseTo(HEIGHT_AT_HARD_CAP / 2, 10);
    expect(columnHeight(250, 1_000)).toBeCloseTo(HEIGHT_AT_HARD_CAP / 4, 10);
  });

  it('上限を超えたら圧縮される（が、単調増加は保つ）', () => {
    const atCap = columnHeight(1_000, 1_000);
    const double = columnHeight(2_000, 1_000);
    const hot = columnHeight(27_000, 1_000);

    expect(double).toBeGreaterThan(atCap);
    expect(hot).toBeGreaterThan(double);
    // 27 倍の需要が 27 倍の高さになってしまうと画面外に出て比較できない。
    expect(hot).toBeLessThan(atCap * 6);
  });

  it('上限の前後で不連続にならない', () => {
    expect(columnHeight(999.999, 1_000)).toBeCloseTo(columnHeight(1_000.001, 1_000), 4);
  });

  it('需要 0 や不正な上限では 0 を返す', () => {
    expect(columnHeight(0, 1_000)).toBe(0);
    expect(columnHeight(-5, 1_000)).toBe(0);
    expect(columnHeight(1_000, 0)).toBe(0);
  });
});

describe('gridPositions', () => {
  it('本数ぶんの位置を返し、中心が原点に来る', () => {
    for (const count of [1, 2, 9, 41, 50]) {
      const positions = gridPositions(count);
      expect(positions).toHaveLength(count);

      // 重心ではなく**外接矩形の中心**が原点に来る（最終行が埋まらないと重心はずれる）。
      // カメラは原点を向いているので、揃っているべきはこちら。
      const xs = positions.map((p) => p.x);
      const zs = positions.map((p) => p.z);
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 6);
      expect(Math.min(...zs) + Math.max(...zs)).toBeCloseTo(0, 6);
    }
  });

  it('柱どうしが重ならない', () => {
    const positions = gridPositions(41);
    const keys = new Set(positions.map((p) => `${p.x.toFixed(4)}:${p.z.toFixed(4)}`));
    expect(keys.size).toBe(positions.length);

    // 隣接する 2 本の間隔は柱の太さより広い。
    const first = positions[0];
    const second = positions[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(Math.abs(second.x - first.x)).toBeCloseTo(COLUMN_SPACING, 10);
  });

  it('0 本でも壊れない', () => {
    expect(gridPositions(0)).toEqual([]);
  });
});

describe('gridExtent', () => {
  it('柱が 1 本しかなくてもカメラが貼りつかない下限がある', () => {
    // big-item-trap はパーティション 1 本。下限が無いとカメラが柱に寄りすぎて
    // 頂上が画角から外れる。
    expect(gridExtent(1)).toBeGreaterThanOrEqual(6);
  });

  it('本数が増えれば広がる', () => {
    expect(gridExtent(50)).toBeGreaterThan(gridExtent(4));
  });
});

/**
 * 粒子の縮尺。
 *
 * ここが M3 の並置を支えている。「同じ負荷を流している」を
 * HUD の文言ではなく**絵で確かめられる**ようにするには、
 * 両サービスの粒子が同じ縮尺で描かれている必要がある。
 * 縮尺がずれると、片方が太く見えるという形で嘘の対比が生まれる。
 */
describe('requestsPerParticle / particleCount', () => {
  it.each([
    ['再送なし', undefined],
    // ⚠️ 再送 ON がこのテストの本体。Aurora の到着量 (offeredRequestsPerSec) は
    // 増幅で膨らむので、そちらで本数を決めると Aurora だけ粒子が増えて
    // 「同じ量を流している」が絵の上で崩れる。素の需要で決めていることを固定する。
    ['再送あり', { clientTimeoutSeconds: 1, clientPopulation: 2_000 }],
  ])('同じ負荷なら、両サービスの粒子数が一致する（%s）', (_label, retry) => {
    // 実際に driver を回して、View が読む snapshot のフィールドで検証する。
    // 縮尺の式だけを 2 回呼ぶと f(x) === f(x) の恒真式になり、
    // 「どちらのフィールドを読むか」というずれやすい判断が固定できない。
    const driver = new TerrariumDriver({
      load: { readsPerSecond: 0, writesPerSecond: 500 },
      dynamodb: sameLoadEverywhere.dynamodb,
      aurora: { ...sameLoadEverywhere.aurora, retry },
      sqs: sameLoadEverywhere.sqs,
    });

    for (let frame = 0; frame < 60 * 60; frame += 1) {
      driver.advance(1 / 60);
      const snapshot = driver.snapshot();
      const scale = requestsPerParticle(
        snapshot.load.readsPerSecond + snapshot.load.writesPerSecond,
      );
      expect(particleCount(snapshot.aurora.demandedRequestsPerSec, scale)).toBe(
        particleCount(snapshot.dynamodb.write.demandedRequestsPerSec, scale),
      );
    }

    // 再送が実際に効いていること（効いていなければ上の検査は素通りしてしまう）。
    const final = driver.snapshot().aurora;
    expect(final.retriedRequestsPerSec > 0).toBe(retry !== undefined);
  });

  it('片方が負荷の半分しか受けていなければ、粒子も半分になる', () => {
    // read/write を分けているとき、DynamoDB は片方のレーンしか描かない。
    // その差が縮尺を通して比例で出ることを固定する（別の縮尺に逃げない）。
    const scale = requestsPerParticle(1_000);
    expect(particleCount(500, scale)).toBeCloseTo(particleCount(1_000, scale) / 2, 0);
  });

  it('どんな負荷でも予算を超えない', () => {
    for (const load of [1, 500, 60_000, 1_000_000]) {
      expect(particleCount(load, requestsPerParticle(load))).toBeLessThanOrEqual(PARTICLE_BUDGET);
    }
  });

  it('Aurora の帯域でも DynamoDB の帯域でも、流れとして見える本数が出る', () => {
    // 400 q/s (Aurora の壁) で粒子が数個しか出ないと「流れ」に見えず、
    // 60,000 q/s (DynamoDB の壁) で数万個出すと描画が死ぬ。
    // 縮尺を負荷から導いているのは、この 150 倍の幅を 1 つの画面で扱うため。
    expect(particleCount(420, requestsPerParticle(420))).toBeGreaterThan(100);
    expect(particleCount(60_000, requestsPerParticle(60_000))).toBeGreaterThan(100);
  });

  it('縮尺は負荷に対して単調に粗くなる（1-2-5 の梯子）', () => {
    let previous = 0;
    for (let load = 100; load <= 200_000; load *= 1.3) {
      const scale = requestsPerParticle(load);
      expect(scale).toBeGreaterThanOrEqual(previous);
      // 1-2-5 の梯子に乗っている（有効数字 1 桁で 1 / 2 / 5 のいずれか）。
      const mantissa = scale / 10 ** Math.floor(Math.log10(scale));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
      previous = scale;
    }
  });

  it('負荷 0 や不正値でも壊れない', () => {
    expect(requestsPerParticle(0)).toBe(1);
    expect(requestsPerParticle(Number.NaN)).toBe(1);
    expect(particleCount(0, 10)).toBe(0);
    expect(particleCount(100, 0)).toBe(0);
    expect(particleCount(Number.NaN, 10)).toBe(0);
  });
});

/**
 * Aurora の設備の寸法。
 *
 * 「窓口は 2→16 なのに待合室は 1,000→4,000」という M3 の主題を、
 * HUD の数字ではなく**寸法そのもの**が語ることを固定する。
 */
describe('auroraSiteMetrics / seatPositions / vcpuGatePositions', () => {
  it('席は max_connections を縮尺で割った数だけある', () => {
    expect(seatCount(1_000)).toBe(1_000 / REQUESTS_PER_SEAT);
    expect(seatCount(4_000)).toBe(4_000 / REQUESTS_PER_SEAT);
    expect(seatPositions(1_000)).toHaveLength(seatCount(1_000));
  });

  it('どのクラスでも、席の数が窓口の本数より桁違いに多い', () => {
    // ⚠️ 主題は**桁が違うこと**であって「上げるほど待合室ばかり増える」ではない。
    // 実際は窓口 16 倍に対し待合室 5 倍なので、比は 500 倍 → 156 倍へ縮まる。
    // それでも桁は変わらない — だから Aurora はどのクラスでもエラーを出さずに遅くなれる。
    for (const spec of Object.values(AURORA_INSTANCE_CLASSES)) {
      const seats = seatCount(spec.maxConnections);
      const gates = vcpuGatePositions(spec.vcpu);
      expect(gates).toHaveLength(spec.vcpu);
      expect(seats).toBeGreaterThan(gates.length * 4);
    }
  });

  it('席の数は max_connections に比例する（4 倍の待合室は 4 倍の面積になる）', () => {
    const large = AURORA_INSTANCE_CLASSES['db.r6g.large'];
    const xlarge4 = AURORA_INSTANCE_CLASSES['db.r6g.4xlarge'];

    const roomLarge = auroraSiteMetrics(large.maxConnections);
    const room4xlarge = auroraSiteMetrics(xlarge4.maxConnections);
    const areaRatio =
      (room4xlarge.roomWidth * room4xlarge.roomDepth) / (roomLarge.roomWidth * roomLarge.roomDepth);
    expect(areaRatio).toBeGreaterThan(3.5);
    expect(areaRatio).toBeLessThan(4.6);
  });

  it('待合室は writer の手前にあり、粒子は入口から窓口へ向かって進む', () => {
    const metrics = auroraSiteMetrics(1_000);
    // 入口 (+z) が最も手前、窓口 (gateZ) が最も奥。この向きが「writer の手前で詰まる」絵を作る。
    expect(metrics.entranceZ).toBeGreaterThan(metrics.roomZ);
    expect(metrics.roomZ).toBeGreaterThan(metrics.gateZ);
    expect(metrics.gateZ).toBeGreaterThan(metrics.writerZ);
  });

  it('席は番号の若い順に窓口へ近い（行列の先頭が窓口）', () => {
    const seats = seatPositions(1_000);
    const first = seats[0];
    const last = seats[seats.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;
    expect(first.z).toBeLessThan(last.z);
  });

  it('席どうしが重ならない', () => {
    const seats = seatPositions(4_000);
    const keys = new Set(seats.map((seat) => `${seat.x.toFixed(4)}:${seat.z.toFixed(4)}`));
    expect(keys.size).toBe(seats.length);
  });

  it('窓口どうしが重ならず、writer の幅に収まる', () => {
    for (const vcpu of [2, 4, 8, 16, 32]) {
      const gates = vcpuGatePositions(vcpu);
      const sorted = [...gates].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)).toBeGreaterThan(0);
      }
      // 外接矩形の中心が原点に来る（writer の正面に揃う）。
      expect(Math.min(...gates) + Math.max(...gates)).toBeCloseTo(0, 6);
    }
  });
});

/**
 * 左右 2 敷地の配置（M3 から変えていない部分）。
 *
 * **どれも初期画角に収まる**ことは M3 / M4-2 の完了条件そのものである。
 * 1 つでも枠の外にあると、そもそも並置になっていない。
 * 3 つ目（SQS・中央奥）の検査は `siteOrigins（3 敷地・弓なり配置）` にある。
 */
describe('siteOrigins / terrariumExtent', () => {
  it('原点を空けて左右に置く（そこに負荷のパイプが立つ）', () => {
    const origins = siteOrigins(50, 1_000);
    expect(origins.dynamodb.x).toBeLessThan(0);
    expect(origins.aurora.x).toBeGreaterThan(0);
    // 原点について対称。パイプの分岐が片方へ寄ると「同じ負荷」に見えなくなる。
    expect(origins.dynamodb.x + origins.aurora.x).toBeCloseTo(0, 10);
  });

  it('敷地どうしが重ならない（パーティションが 50 本でも、待合室が 4,000 席でも）', () => {
    for (const partitions of [1, 4, 25, 50]) {
      for (const maxConnections of [90, 1_000, 4_000, 5_000]) {
        const separation = siteSeparation(partitions, maxConnections);
        const halfWidths =
          gridWidth(partitions) / 2 + auroraSiteMetrics(maxConnections).width / 2;
        expect(separation).toBeGreaterThan(halfWidths);
      }
    }
  });

  it('両方の敷地が、左右のパネルに隠れない帯の中へ収まる', () => {
    // ⚠️ 画角に入っているだけでは足りない。幅 330px のパネルが両側に立っているので、
    // そこを除いた帯の中に収まっていないと、待合室がパネルの下に潜る。
    for (const partitions of [1, 4, 25, 50]) {
      for (const maxConnections of [90, 1_000, 5_000]) {
        const extent = terrariumExtent(partitions, maxConnections);
        const [x, y, z] = initialCameraPosition(extent);

        expect(y).toBeGreaterThan(0); // 地面より上から見ている

        const distance = Math.hypot(x, y - CAMERA_TARGET_HEIGHT, z);
        const halfAngle = Math.tan((CAMERA_FOV_DEGREES / 2) * (Math.PI / 180));
        const visibleHalfWidth = distance * halfAngle * (16 / 9) * VISIBLE_WIDTH_FRACTION;
        expect(visibleHalfWidth).toBeGreaterThanOrEqual(extent - 1e-9);
      }
    }
  });

  it('負荷の分岐パイプが画角の上へ抜けない', () => {
    // ここが抜けると「1 本の負荷が 2 つへ分かれている」が見えなくなる。
    // 並置の主張はそこが崩れると HUD 上の約束事に後退する。
    for (const partitions of [1, 25, 50]) {
      const extent = terrariumExtent(partitions, 1_000);
      const [x, y, z] = initialCameraPosition(extent);
      const distance = Math.hypot(x, y - CAMERA_TARGET_HEIGHT, z);
      const visibleHalfHeight = distance * Math.tan((CAMERA_FOV_DEGREES / 2) * (Math.PI / 180));

      // 収めたいのは地面 (0) から PIPE_TOP まで。注視点からの距離で見る。
      expect(visibleHalfHeight).toBeGreaterThan(PIPE_TOP - CAMERA_TARGET_HEIGHT);
      expect(visibleHalfHeight).toBeGreaterThan(CAMERA_TARGET_HEIGHT);
    }
  });

  it('パーティション 1 本でも、突き抜けた柱の頂上が切れない', () => {
    // big-item-trap は物理上限の 27 倍で高さ 7.7 まで伸びる。
    // 頂上が切れると「どこまで突き抜けているか」が読めなくなる。
    const extent = terrariumExtent(1, 1_000);
    const [x, y, z] = initialCameraPosition(extent);
    const distance = Math.hypot(x, y - CAMERA_TARGET_HEIGHT, z);
    const visibleTop =
      CAMERA_TARGET_HEIGHT + distance * Math.tan((CAMERA_FOV_DEGREES / 2) * (Math.PI / 180));
    expect(visibleTop).toBeGreaterThan(columnHeight(27_000, 1_000));
  });

  it('席の間隔より敷地の余白のほうが広い（待合室が隣の柱にめり込まない）', () => {
    expect(siteSeparation(1, 1_000)).toBeGreaterThan(SEAT_SPACING * 4);
  });
});

/**
 * SQS のレーン。
 *
 * ここが M4-2 の山場である。**「無制限であること」と「絵として収まること」の両立**を
 * 担っているのがこの 2 つの関数で、どちらが壊れても
 * 「SQS は溜めるだけで何も起きない」という主張が絵の上で嘘になる。
 */
describe('backlogLaneLength', () => {
  it('少ない件数では、ほぼ件数に比例する', () => {
    // 膝の手前では素直な量として読める（10 件と 20 件の差が倍に見える）。
    expect(backlogLaneLength(20) / backlogLaneLength(10)).toBeGreaterThan(1.9);
    expect(backlogLaneLength(20) / backlogLaneLength(10)).toBeLessThan(2.0);
  });

  it('⚠️ どこにも折れ目が無い — 柱と決定的に違うところ', () => {
    // `columnHeight` は物理上限で**わざと折る**。折れ目が壁の在り処を語るからである。
    // SQS に壁は無いので、折れ目があると「ここで何かが起きた」という嘘の読みが生まれる。
    //
    // 線形と対数を継いだ実装だと、境目で傾きが半分に跳ねる（比 0.5）。
    // 滑らかな 1 本の曲線なら、標本を 5% 刻みで取る限り比は 0.95 を下回らない。
    let previousSlope = 0;
    let worstRatio = 1;
    for (let backlog = 1; backlog < 1e9; backlog *= 1.05) {
      const next = backlog * 1.05;
      const slope = (backlogLaneLength(next) - backlogLaneLength(backlog)) / (next - backlog);
      if (previousSlope > 0) worstRatio = Math.min(worstRatio, slope / previousSlope);
      previousSlope = slope;
    }
    expect(worstRatio).toBeGreaterThan(0.9);
  });

  it('どこまで溜めても単調に伸びる（頭打ちにしない）', () => {
    // ⚠️ クランプしてはいけない。頭打ちにした瞬間、レーンは「有限の器」に化けて
    // Aurora の待合室と同じものになり、SQS の主張（入口に壁が無い）が消える。
    let previous = -1;
    for (let backlog = 1; backlog <= 1e9; backlog *= 2) {
      const length = backlogLaneLength(backlog);
      expect(length).toBeGreaterThan(previous);
      previous = length;
    }
  });

  it('保持 4 日の理論上限 (1.7 億件) でも絵に収まる長さで止まる', () => {
    // 500 q/s × 4 日 = 172,800,000 件。ここまで対数で潰しておかないと
    // レーンが地平線を突き抜けて、そもそも 1 本の列に見えなくなる。
    expect(backlogLaneLength(172_800_000)).toBeLessThan(25);
  });

  it('⚠️ Aurora の席を流用したときの破綻を避けられている', () => {
    // PLAN.md「M4-2 の壁 2」の実測そのもの。`sqs-retention-cliff` の定常 30,000 件を
    // 席 (REQUESTS_PER_SEAT) の縮尺で描くと一辺 13.2 になり、Aurora の待合室 (2.4) の
    // 5.5 倍に膨れて隣の敷地へめり込む。
    const asSeats = roomWidth(30_000);
    expect(asSeats).toBeGreaterThan(13);
    expect(asSeats).toBeGreaterThan(roomWidth(1_000) * 5);

    // レーンなら、同じ 30,000 件が Aurora の敷地の幅と同じ桁に収まる。
    expect(backlogLaneLength(30_000)).toBeLessThan(asSeats);
    expect(backlogLaneLength(30_000)).toBeLessThan(siteSeparation(1, 1_000));
  });

  it('0 件や不正値では 0（レーンが現れない）', () => {
    expect(backlogLaneLength(0)).toBe(0);
    expect(backlogLaneLength(-1)).toBe(0);
    expect(backlogLaneLength(Number.NaN)).toBe(0);
  });
});

describe('ageBarHeight', () => {
  it('保持期間に対する比で伸びる', () => {
    expect(ageBarHeight(30, 60)).toBeCloseTo(HEIGHT_AT_HARD_CAP / 2, 10);
    expect(ageBarHeight(15, 60)).toBeCloseTo(HEIGHT_AT_HARD_CAP / 4, 10);
  });

  it('保持期間ちょうどで、DynamoDB の物理上限の基準面と同じ高さになる', () => {
    // 3 つの敷地で「この高さが壁」が揃う。柱の基準面と同じ高さに壁を置くのはそのため。
    expect(ageBarHeight(60, 60)).toBe(HEIGHT_AT_HARD_CAP);
    expect(ageBarHeight(4 * 24 * 3_600, 4 * 24 * 3_600)).toBe(HEIGHT_AT_HARD_CAP);
  });

  it('⚠️ 柱と違って決して突き抜けない', () => {
    // 年齢が保持期間を超えたメッセージはもう存在しない。
    // 突き抜けさせると「壁を越えて生き残っているもの」を描くことになる。
    expect(ageBarHeight(600, 60)).toBe(HEIGHT_AT_HARD_CAP);
    expect(ageBarHeight(60 * 1_000, 60)).toBe(HEIGHT_AT_HARD_CAP);
  });

  it('年齢 0 や不正値では 0（棒が現れない）', () => {
    expect(ageBarHeight(0, 60)).toBe(0);
    expect(ageBarHeight(-1, 60)).toBe(0);
    expect(ageBarHeight(30, 0)).toBe(0);
    expect(ageBarHeight(Number.NaN, 60)).toBe(0);
    // ⚠️ Infinity は「壁いっぱい」ではなく 0 に倒す。モジュール全体の作法
    // (`columnHeight` / `backlogLaneLength`) と揃えてある — 描かないほうが安全側。
    expect(ageBarHeight(Number.POSITIVE_INFINITY, 60)).toBe(0);
  });

  it('⚠️ M4 の看板 — 列が縮んでいる最中に、年齢の棒は伸びる', () => {
    // これを 1 つの軸に乗せると主役の現象が消えるので、2 つの軸に分けている。
    // ここでは Core を実際に回して、**同じ瞬間に長さが減り高さが増える**ことを固定する。
    //
    // 保持期間を 300 秒にしているのは、この 120 秒の窓で期限切れを起こさないため
    // （消え始めると長さが減る理由が 2 つに増えて、何を見ているのか分からなくなる）。
    const driver = new TerrariumDriver({
      load: { readsPerSecond: 0, writesPerSecond: 500 },
      dynamodb: sameLoadEverywhere.dynamodb,
      aurora: sameLoadEverywhere.aurora,
      sqs: { consumerCount: 2, messageRetentionSeconds: 300 },
    });

    // 過負荷 500 q/s（容量 400）で 100 秒。先頭は「500 で積まれた層」に居る。
    for (let frame = 0; frame < 100 * 60; frame += 1) driver.advance(1 / 60);
    const retention = driver.snapshot().sqs.messageRetentionSeconds;
    const peak = driver.snapshot().sqs;
    expect(peak.backlogGrowthPerSec).toBeGreaterThan(0);

    // 安全域へ落とす。ここから列は縮み始める。
    driver.setLoad({ writesPerSecond: 300 });
    for (let frame = 0; frame < 20 * 60; frame += 1) driver.advance(1 / 60);
    const recovering = driver.snapshot().sqs;

    // 長さは減っている。
    expect(recovering.queueDepth).toBeLessThan(peak.queueDepth);
    expect(backlogLaneLength(recovering.queueDepth)).toBeLessThan(
      backlogLaneLength(peak.queueDepth),
    );

    // それなのに年齢の棒は伸びている — 先頭がまだ過負荷の層を抜けていないため。
    expect(recovering.oldestMessageAgeSeconds).toBeGreaterThan(peak.oldestMessageAgeSeconds);
    expect(ageBarHeight(recovering.oldestMessageAgeSeconds, retention)).toBeGreaterThan(
      ageBarHeight(peak.oldestMessageAgeSeconds, retention),
    );
  });
});

describe('sqsSiteMetrics', () => {
  it('列は先頭 (consumer 側) が手前で、尾が奥へ伸びる', () => {
    const metrics = sqsSiteMetrics(6_000);
    // 手前 (+z 寄り) が先頭。ここで捌かれ、ここで期限切れが起きる。
    expect(metrics.headZ).toBeGreaterThan(metrics.tailZ);
    // 尾は奥 (-z)。伸びるほどカメラから遠ざかるので、画角を破らない。
    expect(metrics.tailZ).toBeLessThan(0);
    expect(metrics.laneZ).toBeLessThan(metrics.headZ);
    expect(metrics.laneZ).toBeGreaterThan(metrics.tailZ);
  });

  it('溜まるほど尾だけが奥へ下がる（先頭は動かない）', () => {
    const small = sqsSiteMetrics(1_000);
    const large = sqsSiteMetrics(100_000);
    expect(large.headZ).toBe(small.headZ);
    expect(large.tailZ).toBeLessThan(small.tailZ);
  });

  it('0 件なら長さ 0 で、先頭と尾が重なる', () => {
    const empty = sqsSiteMetrics(0);
    expect(empty.laneLength).toBe(0);
    expect(empty.tailZ).toBe(empty.headZ);
  });

  it('年齢の棒はレーンの外に立つ（列に重ならない）', () => {
    expect(AGE_BAR_OFFSET_X).toBeGreaterThan(LANE_WIDTH / 2);
  });
});

/**
 * 3 つの敷地の配置（弓なり）。
 *
 * **3 つとも初期画角に収まる**ことが M4-2 の完了条件そのものである。
 */
describe('siteOrigins（3 敷地・弓なり配置）', () => {
  it('SQS は中央奥に立つ（左右は M3 のまま）', () => {
    const origins = siteOrigins(50, 1_000);
    expect(origins.dynamodb.x).toBeLessThan(0);
    expect(origins.aurora.x).toBeGreaterThan(0);
    // x=0 の地面付近は空いている。ここへ引き込むから横幅が増えない。
    expect(origins.sqs.x).toBe(0);
    expect(origins.sqs.z).toBeLessThan(0);
    expect(origins.dynamodb.z).toBe(0);
    expect(origins.aurora.z).toBe(0);
  });

  it('⚠️ 3 つ目を足してもカメラが引かない — 弓なりを選んだ理由そのもの', () => {
    // PLAN.md「M4-2 の壁 1」の実測: 横一列にすると既定で 21.7 → 35.0 まで引き、
    // 画面内の物が 6 割の大きさになって M2 / M3 の見どころが読めなくなる。
    //
    // ⚠️ 「SQS が画角に収まっている」を見ても意味が無い（x=0 なので常に真になる）。
    // 固定すべきなのは **`terrariumExtent` が SQS に 1 ミリも押し広げられていない**
    // という等式のほうで、それは M3 時点の式を横に置いて突き合わせないと言えない。
    const twoSiteExtent = (partitions: number, maxConnections: number): number =>
      Math.max(
        8, // MIN_TERRARIUM_EXTENT
        siteSeparation(partitions, maxConnections) / 2 +
          Math.max(gridWidth(partitions), auroraSiteMetrics(maxConnections).width) / 2,
      );

    for (const partitions of [1, 4, 25, 50]) {
      for (const maxConnections of [90, 1_000, 4_000, 5_000]) {
        expect(terrariumExtent(partitions, maxConnections)).toBe(
          twoSiteExtent(partitions, maxConnections),
        );
      }
    }

    // 既定プリセット相当での実測値。PLAN.md の表の「2 敷地（現状）」と同じ数字。
    const extent = terrariumExtent(1, 1_000);
    expect(extent).toBeCloseTo(8, 10);
    const [x, y, z] = initialCameraPosition(extent);
    expect(Math.hypot(x, y - CAMERA_TARGET_HEIGHT, z)).toBeCloseTo(21.7, 1);
  });

  it('3 つの敷地がどれも重ならない', () => {
    for (const partitions of [1, 4, 25, 50]) {
      for (const maxConnections of [90, 1_000, 4_000, 5_000]) {
        const origins = siteOrigins(partitions, maxConnections);
        const ddbHalfWidth = gridWidth(partitions) / 2;
        const auroraHalfWidth = auroraSiteMetrics(maxConnections).width / 2;
        // ⚠️ 定数を直書きせず、敷地が申告する幅を使う。年齢の縦棒まで含んだ
        // 実際の箱で見ないと、M4-2b で棒を描いた瞬間に検査の外側へ出る。
        const sqsHalfWidth = sqsSiteMetrics(0).width / 2;
        expect(sqsHalfWidth).toBeGreaterThan(CONSUMER_BANK_WIDTH / 2);
        expect(sqsHalfWidth).toBeGreaterThan(AGE_BAR_OFFSET_X);

        // 左右どうし（M3 から変わっていない）。
        expect(siteSeparation(partitions, maxConnections)).toBeGreaterThan(
          ddbHalfWidth + auroraHalfWidth,
        );

        // SQS と左右。x 方向だけで分離できていること — z の奥行きに頼ると、
        // レーンが伸びたときに横から回り込んで隣へ食い込む。
        expect(Math.abs(origins.dynamodb.x)).toBeGreaterThan(ddbHalfWidth + sqsHalfWidth);
        expect(Math.abs(origins.aurora.x)).toBeGreaterThan(auroraHalfWidth + sqsHalfWidth);
      }
    }
  });

  it('原点を空けたままである（そこに負荷のパイプが立つ）', () => {
    for (const partitions of [1, 25, 50]) {
      for (const maxConnections of [90, 1_000, 5_000]) {
        const origins = siteOrigins(partitions, maxConnections);
        // SQS の設備でいちばん手前の面（consumer 側の前面）が、原点に届かない。
        const nearestFaceZ = origins.sqs.z + CONSUMER_BANK_DEPTH / 2;
        expect(nearestFaceZ).toBeLessThan(0);
        // 手前 2 敷地の奥の縁より、さらに奥に居る。
        expect(sqsSetback(partitions, maxConnections)).toBeGreaterThan(gridWidth(partitions) / 2);
      }
    }
  });

  it('レーンがどれだけ伸びても、原点へ向かって伸びない', () => {
    // 尾は必ず奥 (-z) へ下がる。手前へ伸ばすと原点のパイプを飲み込み、
    // 「1 本の負荷が分岐する」が見えなくなる。
    const origins = siteOrigins(1, 1_000);
    for (const backlog of [1_000, 30_000, 172_800_000]) {
      expect(origins.sqs.z + sqsSiteMetrics(backlog).tailZ).toBeLessThan(origins.sqs.z);
    }
  });
});

/**
 * 地面のグリッド。
 *
 * M4-2a の申し送り 2 — レーンが地面の外へ出る — への回答である。
 * 背景の話に見えるが、**列だけが虚空に浮いていたら「溜まっている」が場所として読めない**。
 */
/**
 * 空間の原点から、レーンの尾までの距離。
 *
 * ⚠️ `setback + backlogLaneLength(件数)` と書いてはいけない。敷地の原点は
 * consumer の設備で、列の先頭はそこから `LANE_HEAD_Z` だけ奥にある。
 * 式を書き写すとその 1 項が落ち、**地面のはみ出しをテスト自身が見逃す**。
 * 寸法を `sqsSiteMetrics` に出させれば、レーンの構造が変わっても自動で追従する。
 */
function tailDistanceFromOrigin(setback: number, backlog: number): number {
  return Math.abs(-setback + sqsSiteMetrics(backlog).tailZ);
}

describe('groundGrid', () => {
  it('マス目の一辺は広げても動かない（空間の縮尺が変わって見えないこと）', () => {
    for (const partitions of [1, 25, 50]) {
      for (const maxConnections of [90, 1_000, 5_000]) {
        const extent = terrariumExtent(partitions, maxConnections);
        const grid = groundGrid(extent, sqsSetback(partitions, maxConnections));
        expect(grid.size / grid.divisions).toBeCloseTo(GROUND_CELL_SIZE, 10);
        expect(Number.isInteger(grid.divisions)).toBe(true);
      }
    }
  });

  it('⚠️ M4-2a の決め打ち (extent * 3) では 30,000 件のレーンが地面から出ていた', () => {
    // 回帰の記録。`sqs-retention-cliff` の定常がちょうどここに当たる
    // （画面がいちばん盛り上がる瞬間に、列だけが虚空へ伸びていく）。
    const extent = terrariumExtent(1, 1_000);
    const setback = sqsSetback(1, 1_000);
    const tailReach = tailDistanceFromOrigin(setback, 30_000);

    expect(tailReach).toBeGreaterThan((extent * 3) / 2);
    expect(tailReach).toBeLessThanOrEqual(groundGrid(extent, setback).size / 2);
  });

  it('どんなバックログでもレーンの尾が地面に載る', () => {
    for (const partitions of [1, 25, 50]) {
      for (const maxConnections of [90, 1_000, 5_000]) {
        const extent = terrariumExtent(partitions, maxConnections);
        const setback = sqsSetback(partitions, maxConnections);
        const halfSpan = groundGrid(extent, setback).size / 2;

        // 1 兆件 — 負荷上限 60,000 件/秒を保持上限 14 日ぶん積んでも届かない量。
        for (const backlog of [1_000, 30_000, 172_800_000, 1e12]) {
          expect(tailDistanceFromOrigin(setback, backlog)).toBeLessThanOrEqual(halfSpan);
        }
      }
    }
  });

  it('手前 2 敷地の周りにも余白が残る', () => {
    // レーンだけを基準にすると、パーティション 50 本のテーブルで
    // 地面が敷地ぴったりになり、柱が崖の縁に立つ。
    for (const partitions of [1, 25, 50]) {
      const extent = terrariumExtent(partitions, 5_000);
      const grid = groundGrid(extent, sqsSetback(partitions, 5_000));
      expect(grid.size / 2).toBeGreaterThan(extent);
    }
  });

  it('不正値でも地面が消えない', () => {
    // ⚠️ ここが 0 になると、シーンから地面ごと消える。
    for (const grid of [groundGrid(Number.NaN, 3), groundGrid(8, Number.NaN), groundGrid(-1, -1)]) {
      expect(grid.size).toBeGreaterThan(0);
      expect(grid.divisions).toBeGreaterThan(0);
    }
  });
});

describe('fogRange', () => {
  it('いちばん奥の敷地が霧に沈まない', () => {
    // ⚠️ M3 までの決め打ち `[extent * 1.8, extent * 5]` は、敷地が 2 つとも z=0 に
    // あることに依存していた。SQS を奥へ置いた瞬間に 3 つ目だけが 5 割方沈む。
    for (const partitions of [1, 25, 50]) {
      for (const maxConnections of [90, 1_000, 5_000]) {
        const extent = terrariumExtent(partitions, maxConnections);
        const origins = siteOrigins(partitions, maxConnections);
        const distance = distanceFromInitialCamera(extent, origins.sqs);
        const [near, far] = fogRange(extent, distance);

        expect(far).toBeGreaterThan(near);
        const fogAtSqs = (distance - near) / (far - near);
        expect(fogAtSqs).toBeLessThanOrEqual(0.25 + 1e-9);

        // 手前の 2 敷地の空気感は残す（霧を殺すのではなく、奥だけを掬い上げる）。
        const frontDistance = distanceFromInitialCamera(extent, origins.dynamodb);
        expect((frontDistance - near) / (far - near)).toBeGreaterThan(0);
      }
    }
  });

  it('かかり始める距離は M3 から動かさない', () => {
    const extent = terrariumExtent(1, 1_000);
    const [near] = fogRange(extent, distanceFromInitialCamera(extent, { x: 0, z: -4 }));
    expect(near).toBeCloseTo(extent * 1.8, 10);
  });

  it('敷地が近ければ M3 と同じ範囲のまま', () => {
    const extent = terrariumExtent(1, 1_000);
    expect(fogRange(extent, 0)).toEqual([extent * 1.8, extent * 5]);
  });

  it('不正値でも有限の範囲を返す（fog が壊れるとシーン全体が飛ぶ）', () => {
    // ⚠️ ここだけは「0 に倒す」では済まない。near === far の霧は補間が 0 除算になる。
    for (const [extent, distance] of [
      [8, Number.NaN],
      [Number.NaN, 10],
      [0, 10],
      [-1, 10],
      [8, Number.POSITIVE_INFINITY],
    ]) {
      const [near, far] = fogRange(extent as number, distance as number);
      expect(Number.isFinite(near)).toBe(true);
      expect(Number.isFinite(far)).toBe(true);
      expect(far).toBeGreaterThan(near);
    }
  });
});

describe('damp', () => {
  it('目標へ近づく', () => {
    const next = damp(0, 10, 12, 1 / 60);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(10);
  });

  it('フレームの刻み方に依存しない（1 回 0.1 秒 ≒ 6 回 1/60 秒）', () => {
    const once = damp(0, 10, 12, 0.1);

    let stepwise = 0;
    for (let i = 0; i < 6; i += 1) stepwise = damp(stepwise, 10, 12, 0.1 / 6);

    expect(stepwise).toBeCloseTo(once, 10);
  });

  it('既に目標なら動かない', () => {
    expect(damp(5, 5, 12, 0.016)).toBeCloseTo(5, 12);
  });
});
