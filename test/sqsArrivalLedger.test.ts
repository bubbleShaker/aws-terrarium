import { describe, expect, it } from 'vitest';
import { ArrivalLedger, MAX_LEDGER_NODES } from '../src/core/services/sqs/arrivalLedger.js';

/**
 * `ArrivalLedger` は「最古メッセージの年齢を FIFO で厳密に求める」ためだけの部品。
 * ここが狂うと `ApproximateAgeOfOldestMessage` が丸ごと嘘になるので、
 * 折れ線の逆引きを単体で固定しておく。
 */
describe('ArrivalLedger — 累積到着量の折れ線', () => {
  it('一定レートなら、通算 n 件目の到着時刻が n / レートになる', () => {
    const ledger = new ArrivalLedger();
    for (let i = 0; i < 100; i += 1) ledger.record(500, 0.1);

    expect(ledger.latestTime).toBeCloseTo(10, 9);
    expect(ledger.latestCumulative).toBeCloseTo(5_000, 6);
    // 500 件/秒なので 1,000 件目は 2 秒時点。
    expect(ledger.timeAtCumulative(1_000)).toBeCloseTo(2, 9);
    expect(ledger.cumulativeAt(2)).toBeCloseTo(1_000, 6);
  });

  it('レートが変わらない限り節を増やさない（ブラウザで何時間でも回せる根拠）', () => {
    const ledger = new ArrivalLedger();
    for (let i = 0; i < 10_000; i += 1) ledger.record(500, 0.1);

    // 起点 (0,0) と末端の 2 つだけ。tick 数に依存しない。
    expect(ledger.nodeCount).toBe(2);
  });

  it('レートを変えたところにだけ節が増える', () => {
    const ledger = new ArrivalLedger();
    for (let i = 0; i < 10; i += 1) ledger.record(100, 0.1);
    for (let i = 0; i < 10; i += 1) ledger.record(900, 0.1);

    // 起点 + 100 の区間の終わり + 900 の区間の終わり。
    expect(ledger.nodeCount).toBe(3);
    // 1 秒までに 100 件、その後 900 件/秒。150 件目は 1 秒 + 50/900 秒。
    expect(ledger.timeAtCumulative(150)).toBeCloseTo(1 + 50 / 900, 9);
  });

  it('到着が途切れた区間では、空白の明けた時刻を返す（年齢を過大にしない）', () => {
    const ledger = new ArrivalLedger();
    ledger.record(100, 1); // 0→1 秒で 100 件
    ledger.record(0, 5); // 1→6 秒は 1 件も来ない
    ledger.record(100, 1); // 6→7 秒で 100 件

    // 通算 100 件目は「空白が明けた 6 秒」に到着する。
    // 空白の先頭 (1 秒) を返してしまうと年齢が 5 秒ぶん過大になる。
    expect(ledger.timeAtCumulative(100)).toBeCloseTo(6, 9);
  });

  it('prune しても、残っている先頭より後ろの逆引きは変わらない', () => {
    const ledger = new ArrivalLedger();
    for (let i = 0; i < 10; i += 1) ledger.record(100, 0.1);
    for (let i = 0; i < 10; i += 1) ledger.record(900, 0.1);

    const before = ledger.timeAtCumulative(150);
    ledger.prune(120);
    expect(ledger.timeAtCumulative(150)).toBeCloseTo(before, 9);
  });

  it('prune した過去を指す cumulativeAt は、捨てた時点の累計で飽和する', () => {
    const ledger = new ArrivalLedger();
    for (let i = 0; i < 20; i += 1) ledger.record(100, 0.1);
    ledger.prune(150);

    // 捨てた領域（＝全件が出ていった領域）を指しても、
    // 残っている先頭の値を返すので「まだ残っているのに期限切れ判定される」ことがない。
    expect(ledger.cumulativeAt(0)).toBeLessThanOrEqual(150);
    expect(ledger.cumulativeAt(-1_000)).toBeLessThanOrEqual(150);
  });

  it('レートが毎 tick 変わっても節が無制限に増えない（安全網）', () => {
    const ledger = new ArrivalLedger();
    for (let i = 0; i < MAX_LEDGER_NODES * 3; i += 1) ledger.record(100 + (i % 7), 0.1);

    expect(ledger.nodeCount).toBeLessThanOrEqual(MAX_LEDGER_NODES);
    // 間引いても両端は残るので、累計と最終時刻は狂わない。
    expect(ledger.latestTime).toBeCloseTo(MAX_LEDGER_NODES * 3 * 0.1, 6);
  });
});
