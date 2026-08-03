import { describe, expect, it } from 'vitest';
import {
  CAMERA_FOV_DEGREES,
  CAMERA_TARGET_HEIGHT,
  COLUMN_SPACING,
  VISIBLE_WIDTH_FRACTION,
  HEIGHT_AT_HARD_CAP,
  PIPE_TOP,
  PARTICLE_BUDGET,
  REQUESTS_PER_SEAT,
  SEAT_SPACING,
  auroraSiteMetrics,
  columnHeight,
  damp,
  gridExtent,
  gridPositions,
  gridWidth,
  initialCameraPosition,
  particleCount,
  requestsPerParticle,
  seatCount,
  seatPositions,
  siteOrigins,
  siteSeparation,
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
 * 2 つの敷地の配置。
 *
 * **両方が初期画角に収まる**ことは M3 の完了条件そのものである。
 * 片方が枠の外にあると、そもそも並置になっていない。
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
