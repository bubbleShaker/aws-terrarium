import { describe, expect, it } from 'vitest';
import type { Demand } from '../src/core/sim/demand.js';
import { SqsQueue, type SqsQueueTickResult } from '../src/core/services/sqs/queue.js';
import {
  SQS_MAX_IN_FLIGHT_MESSAGES,
  SQS_MAX_RETENTION_SECONDS,
  SQS_MIN_RETENTION_SECONDS,
} from '../src/core/services/sqs/limits.js';

const TICK = 0.1;

function write(perSecond: number): Demand {
  return { readsPerSecond: 0, writesPerSecond: perSecond };
}

/** 一定の負荷を `seconds` 秒ぶん流し、最後の tick 結果を返す。 */
function run(queue: SqsQueue, perSecond: number, seconds: number): SqsQueueTickResult {
  const demand = write(perSecond);
  let latest = queue.step(demand, TICK);
  const ticks = Math.round(seconds / TICK);
  for (let i = 1; i < ticks; i += 1) latest = queue.step(demand, TICK);
  return latest;
}

/** 既定の教材キュー。consumer 2 個 × 5ms = 400 件/秒（Aurora db.r6g.large と同容量）。 */
function matchedCapacityQueue(): SqsQueue {
  return new SqsQueue({ consumerCount: 2 });
}

describe('SqsQueue — 入口に壁が無い', () => {
  it('容量の 10 倍を流しても、拒否は 0 で全件がキューへ入る', () => {
    const queue = matchedCapacityQueue();
    const tick = run(queue, 4_000, 5);

    expect(queue.capacityPerSec).toBe(400);
    expect(tick.rejectedMessagesPerSec).toBe(0);
    expect(tick.enqueuedMessagesPerSec).toBe(4_000);
    expect(tick.demandedMessagesPerSec).toBe(4_000);
  });

  it('バックログが何件あっても、送信レイテンシは 1 ミリも動かない', () => {
    const queue = matchedCapacityQueue();
    const first = run(queue, 500, 0.1);
    const later = run(queue, 500, 600);

    expect(later.queueDepth).toBeGreaterThan(50_000);
    // producer 側の監視ダッシュボードが完全な無風に見える理由がこれ。
    expect(later.sendLatencySeconds).toBe(first.sendLatencySeconds);
  });

  it('read と write は合算してキューへ入る', () => {
    const queue = matchedCapacityQueue();
    const tick = queue.step({ readsPerSecond: 300, writesPerSecond: 200 }, TICK);
    expect(tick.enqueuedMessagesPerSec).toBe(500);
  });

  it('NaN の負荷は 0 に潰して受け、持続状態を壊さない', () => {
    const queue = matchedCapacityQueue();
    run(queue, 500, 10);
    const before = queue.queueDepth;

    queue.step({ readsPerSecond: Number.NaN, writesPerSecond: Number.NaN }, TICK);
    expect(Number.isFinite(queue.queueDepth)).toBe(true);
    // 到着 0・消化ありなので減る。NaN が Q へ流れ込んでいたら以降ずっと NaN になる。
    expect(queue.queueDepth).toBeLessThan(before);
    expect(queue.step(write(500), TICK).oldestMessageAgeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('SqsQueue — 出口が唯一の壁', () => {
  it('過負荷でも消化レートは容量に張り付き、超過分がそのまま溜まる', () => {
    const queue = matchedCapacityQueue();
    const tick = run(queue, 500, 60);

    expect(tick.consumedMessagesPerSec).toBeCloseTo(400, 6);
    expect(tick.backlogGrowthPerSec).toBeCloseTo(100, 6);
    // 60 秒 × 100 件/秒。
    expect(tick.queueDepth).toBeCloseTo(6_000, 3);
  });

  it('保存則: 累計の消化数は「容量 × 経過時間」を決して超えない', () => {
    const queue = matchedCapacityQueue();
    // 無負荷の休止を挟んでも、貯金のような形で容量を先取りできてはいけない
    // （DynamoDB のバーストと違い、キューには「貯めた容量」の概念が無い）。
    run(queue, 0, 100);
    run(queue, 40_000, 30);

    expect(queue.cumulativeConsumed).toBeLessThanOrEqual(
      queue.capacityPerSec * queue.elapsedSeconds + 1e-6,
    );
  });

  it('consumer を増やすとバックログを掃ける（Aurora と正反対の性質）', () => {
    const queue = matchedCapacityQueue();
    run(queue, 500, 120);
    const backlog = queue.queueDepth;
    expect(backlog).toBeGreaterThan(10_000);

    // 実機でも「スケールしたらキューの中身が消える」ことは無い。
    // 溜めておいて後から捌けることが、キューの唯一にして最大の利点である。
    queue.consumerCount = 8;
    expect(queue.queueDepth).toBe(backlog);

    // 容量 1,600 に対し到着 500。余剰 1,100 件/秒で掃ける。
    const tick = run(queue, 500, 30);
    expect(tick.queueDepth).toBe(0);
  });

  it('in-flight 120,000 を超えて consumer を並べても消化レートは伸びない', () => {
    const queue = new SqsQueue({ consumerCount: SQS_MAX_IN_FLIGHT_MESSAGES * 3 });

    expect(queue.inFlightLimited).toBe(true);
    expect(queue.effectiveConsumerCount).toBe(SQS_MAX_IN_FLIGHT_MESSAGES);
    // 積める件数は無制限でも、同時に処理中にできる件数には上限がある。
    expect(queue.capacityPerSec).toBe(SQS_MAX_IN_FLIGHT_MESSAGES / 0.005);
  });

  it('処理中の件数は窓口の数までで、残りは visible なまま待つ', () => {
    const queue = matchedCapacityQueue();
    const tick = run(queue, 500, 60);

    expect(tick.inFlight).toBe(2);
    expect(tick.backlogVisible).toBeCloseTo(tick.queueDepth - 2, 6);
    expect(tick.inFlightUtilization).toBeCloseTo(2 / SQS_MAX_IN_FLIGHT_MESSAGES, 12);
  });
});

describe('SqsQueue — 最古メッセージの年齢（M4 の看板）', () => {
  it('過負荷では、年齢が「1 − 消化 ÷ 到着」の速さで伸びる', () => {
    const queue = matchedCapacityQueue();
    const tick = run(queue, 500, 100);

    // 400/500 が捌けるので、先頭は毎秒 0.2 秒ずつ置き去りにされる。
    expect(tick.oldestMessageAgeSeconds).toBeCloseTo(20, 3);
  });

  it('⚠️ 負荷を安全域へ下げても、最古の年齢は掃けきるまで伸び続ける', () => {
    const queue = matchedCapacityQueue();
    run(queue, 500, 100);
    const atPeak = queue.step(write(500), TICK);
    // 100.1 秒 × (1 − 400/500)。年齢は毎秒 0.2 秒ずつ伸びる。
    expect(atPeak.oldestMessageAgeSeconds).toBeCloseTo(20.02, 6);

    // 300 件/秒 = 容量 400 の 75%。完全な安全域で、バックログは減り始める。
    const draining = run(queue, 300, 20);
    expect(draining.queueDepth).toBeLessThan(atPeak.queueDepth);

    // それでも先頭は先頭のまま。負荷が正常でも年齢だけが伸び続ける。
    // ここが `年齢 ≈ Q / 消化レート` の近似では消えてしまう現象で、
    // 近似だと Q が減るのに合わせて年齢まで減ってしまう。
    expect(draining.oldestMessageAgeSeconds).toBeGreaterThan(atPeak.oldestMessageAgeSeconds);
    expect(draining.oldestMessageAgeSeconds).toBeCloseTo(24.02, 6);

    // 近似 (`Q ÷ 消化レート`) との差を数字で押さえておく。
    // **近似は下がり、実際の年齢は上がる — 動く向きが逆**である。
    // 大小がずれているのではなく、警報として意味が正反対になるのが問題の本質。
    const approxAtPeak = atPeak.queueDepth / queue.capacityPerSec;
    const approxDraining = draining.queueDepth / queue.capacityPerSec;
    expect(approxAtPeak).toBeCloseTo(25.025, 6);
    expect(approxDraining).toBeCloseTo(20.025, 6);
    expect(approxDraining).toBeLessThan(approxAtPeak);
  });

  it('掃けきると年齢は 0 に戻る', () => {
    const queue = matchedCapacityQueue();
    run(queue, 500, 60);
    const tick = run(queue, 0, 60);

    expect(tick.queueDepth).toBe(0);
    expect(tick.oldestMessageAgeSeconds).toBe(0);
  });

  it('キューは障害を消さない。時間軸へ引き伸ばす', () => {
    const queue = matchedCapacityQueue();

    // 超過 100 件/秒 の過負荷を 120 秒。
    run(queue, 500, 120);
    expect(queue.queueDepth).toBeCloseTo(12_000, 2);

    // 余剰も 100 件/秒（300 q/s）にして回復させると、掃けるのに**同じ 120 秒**かかる。
    // 「過負荷は 2 分で終わったのに、影響は 4 分続いた」がこれ。
    const after60 = run(queue, 300, 60);
    expect(after60.queueDepth).toBeCloseTo(6_000, 2);
    const after120 = run(queue, 300, 60);
    expect(after120.queueDepth).toBeCloseTo(0, 6);
  });
});

describe('SqsQueue — 保持期間（エラーを伴わない唯一のデータ損失）', () => {
  it('年齢が保持期間に達した瞬間から、エラー無しでメッセージが消え始める', () => {
    const queue = new SqsQueue({ consumerCount: 2, messageRetentionSeconds: 60 });

    // 年齢は毎秒 0.2 秒ずつ伸びるので、60 秒に達するのは 300 秒後。
    const before = run(queue, 500, 290);
    expect(before.expiredMessagesPerSec).toBe(0);
    expect(queue.cumulativeExpired).toBe(0);

    const after = run(queue, 500, 30);
    expect(after.expiredMessagesPerSec).toBeGreaterThan(0);
    expect(queue.cumulativeExpired).toBeGreaterThan(0);

    // 誰も失敗していない。producer は送信に成功し、consumer は受信に成功している。
    expect(after.rejectedMessagesPerSec).toBe(0);
    expect(after.consumedMessagesPerSec).toBeCloseTo(400, 6);
    expect(after.sendLatencySeconds).toBe(before.sendLatencySeconds);
  });

  it('⚠️ 定常状態でのキューの深さは「到着レート × 保持期間」— 消化レートは効かない', () => {
    const queue = new SqsQueue({ consumerCount: 2, messageRetentionSeconds: 60 });
    run(queue, 500, 1_000);

    // 500 件/秒 × 60 秒 = 30,000 件。**消化レート 400 は 1 ミリも効いていない。**
    // キューに残っているのは「保持期間ぶんの到着量」そのもので、
    // それより古いものは捌けたか消えたかのどちらかで、もう居ないため。
    expect(queue.queueDepth).toBeCloseTo(30_000, 0);
    // 消化レート基準（400 × 60 = 24,000）ではないことを明示的に固定する。
    expect(queue.queueDepth).not.toBeCloseTo(24_000, 0);

    const tick = queue.step(write(500), TICK);
    expect(tick.retentionUtilization).toBeCloseTo(1, 2);
    // 消えるのは超過分そのもの。
    expect(tick.expiredMessagesPerSec).toBeCloseTo(100, 3);
  });

  it('待ち時間は保持期間を超えない（前に並んでいる客は期限切れでも減るため）', () => {
    const queue = new SqsQueue({ consumerCount: 2, messageRetentionSeconds: 60 });
    const tick = run(queue, 500, 1_000);

    // Q / 消化容量 なら 30,000 / 400 = 75 秒 — 保持期間より長く、
    // 「60 秒で消える列に 75 秒並ぶ」というありえない値になる。
    expect(tick.queueDepth / queue.capacityPerSec).toBeCloseTo(75, 0);
    expect(tick.endToEndLatencySeconds).toBeLessThanOrEqual(60 + queue.processingTimeSeconds);
    expect(tick.endToEndLatencySeconds).toBeCloseTo(60 + queue.processingTimeSeconds, 1);
  });

  it('消えた件数は「到着 − 消化 − 残存」と一致する（無から生み出していない）', () => {
    const queue = new SqsQueue({ consumerCount: 2, messageRetentionSeconds: 60 });
    run(queue, 500, 600);

    const accounted = queue.cumulativeConsumed + queue.cumulativeExpired + queue.queueDepth;
    expect(accounted).toBeCloseTo(queue.cumulativeArrivals, 3);
  });

  it('保持期間の範囲外は構築時にも変更時にも弾く', () => {
    expect(() => new SqsQueue({ consumerCount: 2, messageRetentionSeconds: 59 })).toThrow(RangeError);
    expect(
      () => new SqsQueue({ consumerCount: 2, messageRetentionSeconds: SQS_MAX_RETENTION_SECONDS + 1 }),
    ).toThrow(RangeError);

    const queue = matchedCapacityQueue();
    expect(() => {
      queue.messageRetentionSeconds = 0;
    }).toThrow(RangeError);
    expect(() => {
      queue.messageRetentionSeconds = SQS_MIN_RETENTION_SECONDS;
    }).not.toThrow();
  });

  it('consumer 数と tick 幅は正の有限数でなければ弾く', () => {
    expect(() => new SqsQueue({ consumerCount: 0 })).toThrow(RangeError);
    expect(() => new SqsQueue({ consumerCount: Number.NaN })).toThrow(RangeError);
    expect(() => matchedCapacityQueue().step(write(1), 0)).toThrow(RangeError);
  });
});

describe('SqsQueue — 決定論性', () => {
  it('同じ設定・同じ入力なら、tick 幅を分割しても結果が一致する', () => {
    const a = matchedCapacityQueue();
    const b = matchedCapacityQueue();

    run(a, 500, 60);
    run(b, 500, 60);

    expect(b.queueDepth).toBe(a.queueDepth);
    expect(b.cumulativeConsumed).toBe(a.cumulativeConsumed);
  });

  it('乱数を使っていない（同じ経路を 2 回走らせて完全一致）', () => {
    const snapshotOf = (): SqsQueueTickResult => {
      const queue = matchedCapacityQueue();
      run(queue, 500, 30);
      run(queue, 200, 30);
      return queue.step(write(500), TICK);
    };
    expect(snapshotOf()).toEqual(snapshotOf());
  });
});
