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

  it('⚠️ バックログが減っていても、年齢が伸びている限り猶予を出し続ける', () => {
    // ここが M4 でいちばん壊しやすい 1 点。
    // 「掃け始めたら安全」と考えて猶予を消すと、実際には消失へ向かっているのに
    // 警報だけが消える。閉じた式 `1 − 消化 ÷ 到着` はまさにそう振る舞う
    // （分母が「先頭が到着した当時のレート」でなければならないため符号ごと間違える）。
    const session = new SqsLiveSession({ consumerCount: 2, messageRetentionSeconds: 60 });
    run(session, 500, 275);
    const overloaded = session.snapshot();
    expect(overloaded.oldestMessageAgeSeconds).toBeCloseTo(55, 0);

    // 399 q/s は容量 400 を下回る安全域。バックログは減り始める。
    const draining = run(session, 399, 1);
    expect(draining.backlogGrowthPerSec).toBeLessThan(0);
    expect(draining.secondsToDrain).toBeGreaterThan(0);

    // それでも年齢は伸び続けており、このままなら消失に至る。
    expect(draining.oldestMessageAgeGrowthPerSec).toBeGreaterThan(0);
    expect(draining.secondsUntilFirstExpiry).toBeDefined();
    expect(draining.secondsUntilFirstExpiry).toBeCloseTo(24, 0);

    // 予告どおり、25 秒後には本当に消え始める。
    const expiring = run(session, 399, 30);
    expect(expiring.expiredMessagesPerSec).toBeGreaterThan(0);
  });

  it('⚠️ 送信を止めても、先頭が過負荷の層に居る間は年齢が伸び続ける', () => {
    // 年齢が伸びる速さを決めているのは「**先頭が到着した当時の**到着レート」なので、
    // いま 1 件も送っていなくても、先頭が過負荷の層に居る限り伸び続ける。
    // 「送信を止めたのだから、あとは待てばよい」が通じない — 保持期間が先に来ることがある。
    // ⚠️ ただし「止めれば必ず伸び続ける」ではない。下のテストが反例を押さえている。
    const session = new SqsLiveSession({ consumerCount: 2, messageRetentionSeconds: 60 });
    run(session, 500, 100);
    const stopped = run(session, 0, 5);

    expect(stopped.enqueuedMessagesPerSec).toBe(0);
    expect(stopped.oldestMessageAgeGrowthPerSec).toBeGreaterThan(0);
    expect(stopped.secondsUntilFirstExpiry).toBeDefined();
  });

  it('⚠️ 年齢が止まっている平衡点で、猶予が天文学的な数字に化けない', () => {
    // 伸びる速さは前 tick との差で実測しているので、年齢が止まると
    // **ほぼ等しい 2 数の引き算**になり、桁落ちで ±5e-13 の揺れが出る。
    // それで残り時間を割ると 6e+13 秒（約 200 万年）が出て、
    // 符号も揺れるので HUD が「—」と天文学的な数字を往復する。
    const session = new SqsLiveSession({ consumerCount: 2, messageRetentionSeconds: 60 });
    // 過負荷で 500 件/秒 の層を 50,000 件つくってから、容量ちょうどへ落とす。
    run(session, 500, 100);

    // ⚠️ 先頭が 500 の層を抜けきるまで（さらに 25 秒）は伸び続けるので、
    // そこを通り越すまで回さないと平衡点に届かない。
    // ガード無しだとこの区間の 25 tick で 2.5e+14 秒（780 万年）が出る。
    let sawEquilibrium = false;
    for (let i = 0; i < 1_000; i += 1) {
      const snapshot = run(session, 400, 0.1);
      if (snapshot.oldestMessageAgeGrowthPerSec === 0) sawEquilibrium = true;

      const grace = snapshot.secondsUntilFirstExpiry;
      if (grace !== undefined) {
        // 出すなら現実的な範囲であること（保持期間の 1,000 倍を超えたら明らかに桁落ち）。
        expect(grace).toBeLessThan(60 * 1_000);
      }
    }
    // テストが平衡点に届かないまま通っていないことを確かめる。
    expect(sawEquilibrium).toBe(true);
  });

  it('掃けきってはじめて年齢も猶予も消える', () => {
    const session = new SqsLiveSession({ consumerCount: 2, messageRetentionSeconds: 60 });
    run(session, 500, 100);
    // 10,010 件を 400 件/秒で掃くのに 25 秒。
    const drained = run(session, 0, 30);

    expect(drained.queueDepth).toBe(0);
    expect(drained.oldestMessageAgeSeconds).toBe(0);
    expect(drained.secondsUntilFirstExpiry).toBeUndefined();
  });

  it('処理時間を速くしてもバックログは持ち越す（consumer 数と同じ扱い）', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    run(session, 500, 120);
    const before = session.snapshot();

    // 「consumer を増やす」を許して「consumer のコードを速くする」を禁じる理由は無い。
    expect(session.update({ processingTimeMs: 1 })).toBe(false);
    const after = session.snapshot();
    expect(after.queueDepth).toBe(before.queueDepth);
    expect(after.capacityPerSec).toBe(2_000);
  });

  it('update() が途中で失敗しても、設定と queue が食い違わない', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);

    // 保持期間が下限割れなので失敗する。consumer 数だけ適用されて残ってはいけない。
    expect(() => session.update({ consumerCount: 8, messageRetentionSeconds: 10 })).toThrow(
      RangeError,
    );

    const snapshot = session.snapshot();
    expect(snapshot.consumerCount).toBe(2);
    expect(session.settings.consumerCount).toBe(2);
    expect(snapshot.consumerCount).toBe(session.queue.consumerCount);
  });

  it('スナップショットは設定ではなく queue に効いている値を返す', () => {
    const session = new SqsLiveSession(defaultSqsLiveSettings);
    session.update({ consumerCount: 4 });

    // 設定側を見ていると「HUD は 4 と言っているが queue は 2 で回っている」がありえる。
    expect(session.snapshot().consumerCount).toBe(session.queue.consumerCount);
    expect(session.snapshot().capacityPerSec).toBe(session.queue.capacityPerSec);
  });
});
