import { describe, expect, it } from 'vitest';
import type { Demand } from '../src/core/sim/demand.js';
import {
  SqsLiveSession,
  defaultSqsLiveSettings,
  type SqsSessionSnapshot,
} from '../src/core/scenario/sqs/liveSession.js';

const TICK = 0.1;

function write(perSecond: number): Demand {
  return { readsPerSecond: 0, writesPerSecond: perSecond };
}

function run(session: SqsLiveSession, perSecond: number, seconds: number): SqsSessionSnapshot {
  const demand = write(perSecond);
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i += 1) session.step(demand, TICK);
  return session.snapshot();
}

describe('SqsLiveSession — 既定値', () => {
  it('consumer 2 個 × 5ms = 400 件/秒（Aurora db.r6g.large と同容量）', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    const snapshot = session.snapshot();

    expect(snapshot.capacityPerSec).toBe(400);
    expect(snapshot.consumerCount).toBe(2);
    expect(snapshot.processingTimeMs).toBe(5);
    // 既定の保持期間は 4 日。
    expect(snapshot.messageRetentionSeconds).toBe(4 * 24 * 60 * 60);
  });

  it('まだ 1 度も進んでいなくても、View が読む値は 0 で埋まっている', () => {
    const snapshot = new SqsLiveSession(defaultSqsLiveSettings).snapshot();

    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.oldestMessageAgeSeconds).toBe(0);
    expect(snapshot.secondsToDrain).toBeUndefined();
    expect(snapshot.secondsUntilFirstExpiry).toBeUndefined();
  });
});

describe('SqsLiveSession — 設定変更でバックログを失わない（Aurora と正反対）', () => {
  it('consumer を増やしてもキューを作り直さない', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    run(session, 500, 120);
    const before = session.snapshot();
    expect(before.queueDepth).toBeGreaterThan(10_000);

    const rebuilt = session.update({ consumerCount: 8 });

    // ここで true になったら、「スケールしたらバックログが消えた」ことになり、
    // キューの唯一にして最大の利点が「溜めたものが無かったことになる」に化ける。
    expect(rebuilt).toBe(false);
    const after = session.snapshot();
    expect(after.queueDepth).toBe(before.queueDepth);
    expect(after.generation).toBe(before.generation);
    expect(after.capacityPerSec).toBe(1_600);
  });

  it('保持期間を縮めると、その場で消え始めることがある（実機どおりの罠）', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    run(session, 500, 300);
    expect(session.snapshot().expiredMessagesPerSec).toBe(0);

    // すでに最古が 60 秒に達しているところへ保持期間 60 秒を設定する。
    session.update({ messageRetentionSeconds: 60 });
    const after = run(session, 500, 1);
    expect(after.expiredMessagesPerSec).toBeGreaterThan(0);
  });

  it('処理時間を update() で変えようとしたら、黙って無視せず例外にする', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    expect(() => session.update({ processingTimeMs: 20 })).toThrow(RangeError);
    // 例外のあとも設定と queue は一致したままでなければならない。
    expect(session.snapshot().processingTimeMs).toBe(5);
    expect(session.settings.processingTimeMs).toBeUndefined();
  });

  it('replace() はバックログごと初期状態へ戻す（プリセットの役目）', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    run(session, 500, 120);
    expect(session.snapshot().queueDepth).toBeGreaterThan(10_000);

    const rebuilt = session.replace(defaultSqsLiveSettings);

    expect(rebuilt).toBe(true);
    const after = session.snapshot();
    expect(after.queueDepth).toBe(0);
    expect(after.simulatedSeconds).toBe(0);
    expect(after.generation).toBe(1);
  });

  it('replace() は update() へ委譲していない（省略したフィールドが残留しない）', () => {
    const session = new SqsLiveSession({ consumerCount: 2, messageRetentionSeconds: 60 });
    session.replace(defaultSqsLiveSettings);

    // マージだと 60 秒が残り、「4 日保持のはずが 1 分で消える」キューができる。
    expect(session.snapshot().messageRetentionSeconds).toBe(4 * 24 * 60 * 60);
  });

  it('不正な設定で replace() が失敗しても、動いているキューを壊さない', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    run(session, 500, 30);
    const before = session.snapshot();

    expect(() => session.replace({ consumerCount: -1 })).toThrow(RangeError);
    expect(session.snapshot().queueDepth).toBe(before.queueDepth);
    expect(session.snapshot().consumerCount).toBe(2);
  });
});

describe('SqsLiveSession — 教材の主張を担う数字', () => {
  it('過負荷の間は secondsToDrain が undefined（掃けないのだから残り時間は無い）', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    const snapshot = run(session, 500, 60);

    expect(snapshot.backlogGrowthPerSec).toBeCloseTo(100, 6);
    expect(snapshot.secondsToDrain).toBeUndefined();
  });

  it('回復時間は「過負荷の継続時間 × 超過分 ÷ 余剰」で出る', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    // 超過 100 件/秒 を 120 秒 → 12,000 件。
    run(session, 500, 120);

    // 余剰も 100 件/秒（300 q/s）。掃けるのに同じ 120 秒かかる。
    const snapshot = run(session, 300, 1);
    expect(snapshot.secondsToDrain).toBeCloseTo(119, 0);
  });

  it('黙って消え始めるまでの猶予を、保持期間へ到達する前に出す', () => {
    const session = new SqsLiveSession({ consumerCount: 2, messageRetentionSeconds: 60 });
    // 年齢は毎秒 0.2 秒ずつ伸びるので、60 秒に達するのは 300 秒後。
    const snapshot = run(session, 500, 100);

    expect(snapshot.expiredMessagesPerSec).toBe(0);
    expect(snapshot.oldestMessageAgeSeconds).toBeCloseTo(20, 1);
    // 残り 40 秒ぶんの年齢を、毎秒 0.2 秒の伸びで割る → 200 秒。
    expect(snapshot.secondsUntilFirstExpiry).toBeCloseTo(200, 0);
  });

  it('掃けている間は「消えるまでの猶予」を出さない', () => {
    const session = new SqsLiveSession({ consumerCount: 2, messageRetentionSeconds: 60 });
    run(session, 500, 100);
    const snapshot = run(session, 100, 1);

    expect(snapshot.secondsUntilFirstExpiry).toBeUndefined();
    expect(snapshot.secondsToDrain).toBeGreaterThan(0);
  });

  it('スナップショットは設定ではなく queue に効いている値を返す', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    session.update({ consumerCount: 4 });

    // 設定側を見ていると「HUD は 4 と言っているが queue は 2 で回っている」がありえる。
    expect(session.snapshot().consumerCount).toBe(session.queue.consumerCount);
    expect(session.snapshot().capacityPerSec).toBe(session.queue.capacityPerSec);
  });
});
