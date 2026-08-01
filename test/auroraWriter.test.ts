import { describe, expect, it } from 'vitest';
import { erlangCWaitSeconds } from '../src/core/services/aurora/erlangC.js';
import {
  AuroraWriter,
  type AuroraRetryPolicy,
  type AuroraWriterTickResult,
} from '../src/core/services/aurora/writer.js';

/**
 * Aurora writer の待ち行列モデル。
 *
 * 検証の方針は M1 のバースト検証と同じ構造を取る:
 *
 * - **理論値が使える領域（ρ<1）では理論値に照合する** — Erlang C をテストオラクルにする
 * - **理論値が使えない領域（ρ≥1）は保存則で守る** — 累計処理数 ≤ 容量 × 経過時間
 * - **Little の法則 `L = λW`** を全 tick の不変条件にする
 *
 * この経路に乱数は 1 つも無い（Erlang C は式であってサンプリングではない）ので、
 * DynamoDB 側よりさらに強く決定論的になる。閾値をぼかす必要が無い。
 */

// db.r6g.large: vCPU 2 / max_connections 1,000 / 1 クエリ 5ms
// → μ = 200 q/s/core、総容量 400 q/s。DynamoDB 側と桁を揃えてある。
const VCPU = 2;
const SERVICE_RATE = 200;
const MAX_CONNECTIONS = 1_000;
const CAPACITY = 400;

/**
 * ⚠️ このファイルが固定している看板の数値（定常 Q = 960 / 最初のエラーまで 48 秒）は
 * **dt に依存する離散化の産物**である。tick 末の Q は「上限 − 容量×dt」で頭打ちになるため:
 *
 * | dt | 定常 Q | 最初のエラーまで |
 * |---|---|---|
 * | 0.1 | 960 | 48.0 秒 |
 * | 0.5 | 800 | 40 秒 |
 * | 1.0 | 600 | 30 秒 |
 *
 * `SimulationClock` の固定タイムステップが 0.1 秒なので現状は整合しているが、
 * それを変えるとここの数値がまとめてズレる。research の実測値も dt=0.1 前提。
 */
const DT = 0.1;

function build(retry?: AuroraRetryPolicy): AuroraWriter {
  return new AuroraWriter({ instanceClass: 'db.r6g.large', serviceTimeMs: 5, retry });
}

/** 書き込み負荷を `seconds` 秒ぶん流し、全 tick の結果を返す。 */
function run(
  writer: AuroraWriter,
  writesPerSecond: number,
  seconds: number,
): AuroraWriterTickResult[] {
  const ticks: AuroraWriterTickResult[] = [];
  for (let t = 0; t < Math.round(seconds / DT); t += 1) {
    ticks.push(writer.step({ readsPerSecond: 0, writesPerSecond }, DT));
  }
  return ticks;
}

function last<T>(items: readonly T[]): T {
  const value = items[items.length - 1];
  if (value === undefined) throw new Error('tick が 1 つも無い');
  return value;
}

describe('AuroraWriter の諸元', () => {
  it('公式表の値をそのまま使う（式の計算結果ではなく表）', () => {
    const writer = build();
    expect(writer.maxVcpu).toBe(VCPU);
    expect(writer.maxConnections).toBe(MAX_CONNECTIONS);
    expect(writer.capacityPerSec).toBe(CAPACITY);
    // 並ぶ場所が、捌ける本数の 500 倍広い。これが「静かに遅くなる」の正体。
    expect(writer.maxConnections / writer.maxVcpu).toBe(500);
  });

  it('未知のインスタンスクラスは例外で弾く（プロトタイプ由来の名前も含めて）', () => {
    // `in` で書くと 'constructor' 等が Object.prototype 経由で素通りし、
    // 諸元が undefined のまま NaN が View まで流れる。例外より遥かに追いにくい壊れ方になる。
    for (const bad of ['constructor', 'toString', 'valueOf', 'db.r6g.medium', '']) {
      expect(() => new AuroraWriter({ instanceClass: bad as never })).toThrow(RangeError);
    }
  });

  it('壊れた需要 (NaN) を流しても、行列が恒久的に汚染されない', () => {
    // Q は tick をまたぐ状態なので、一度 NaN が入ると以降ずっと復帰できなくなる。
    const writer = build();
    writer.step({ readsPerSecond: Number.NaN, writesPerSecond: Number.NaN }, DT);
    expect(writer.queueLength).toBe(0);

    const tick = last(run(writer, CAPACITY * 0.9, 60));
    expect(tick.waitSeconds * 1_000).toBeCloseTo(21.3, 1);
  });
});

describe('ρ<1 の定常状態は Erlang C の理論値と一致する', () => {
  it.each([0.5, 0.7, 0.8, 0.9, 0.95])('ρ=%s', (rho) => {
    const lambda = CAPACITY * rho;
    const tick = last(run(build(), lambda, 120));

    // 流体の行列は空になる（到着 ≤ 容量 なので溜まらない）。
    expect(tick.queueLength).toBeCloseTo(0, 9);
    expect(tick.backpressureSeconds).toBeCloseTo(0, 9);

    // 待ち時間は統計項が丸ごと担当する。
    // ここは実装と同じ関数を呼んでいるので「配線が正しいか」の検査。
    // 式そのものが正しいかは test/auroraErlangC.test.ts が独立な式で見ている。
    expect(tick.waitSeconds).toBeCloseTo(erlangCWaitSeconds(VCPU, SERVICE_RATE, lambda), 12);
    // 拒否は 1 件も出ず、需要はすべて捌ける。
    expect(tick.rejectedRequestsPerSec).toBe(0);
    expect(tick.servedRequestsPerSec).toBeCloseTo(lambda, 9);
  });

  it('流体モデル単独では消えてしまう「飽和前から遅くなる」が残っている', () => {
    // 案 B（流体のみ）を採らなかった理由そのもの。
    // ρ=0.98 でも行列は空だが、待ち時間は 0 ではない。
    const tick = last(run(build(), CAPACITY * 0.98, 120));
    expect(tick.queueLength).toBeCloseTo(0, 9);
    expect(tick.backpressureSeconds).toBeCloseTo(0, 9);
    expect(tick.waitSeconds * 1_000).toBeCloseTo(121.3, 1);

    // 利用率 50% → 95% で、使う容量は 1.9 倍なのに待ち時間は 28 倍。
    const slow = last(run(build(), CAPACITY * 0.95, 120)).waitSeconds;
    const fast = last(run(build(), CAPACITY * 0.5, 120)).waitSeconds;
    expect(slow / fast).toBeGreaterThan(25);
  });
});

describe('Little の法則 L = λW', () => {
  // ⚠️ この不変条件は更新式の形から**代数的に必ず成立する**
  // （tick 末は「Q=0」か「throughput=総容量」のどちらかにしかならないため）。
  // したがってこれはモデルの検証ではなく、
  // **L の 3 項（行列長・統計項・稼働中）のどれかを取り違えた場合の回帰ガード**である。
  // 本物の検証は下の「閉形式と突き合わせる」テストが担う。
  const phases = [
    { lambda: 0, seconds: 5 }, // 無負荷
    { lambda: CAPACITY * 0.5, seconds: 30 }, // 余裕
    { lambda: CAPACITY * 0.95, seconds: 30 }, // 飽和寸前
    { lambda: CAPACITY * 3, seconds: 60 }, // 過負荷（行列が上限に張り付く）
    { lambda: CAPACITY * 0.2, seconds: 60 }, // 回復の過渡状態
  ];

  it.each([false, true])('再送あり=%s: 全 tick で成立する', (withRetry) => {
    const writer = build(withRetry ? { clientTimeoutSeconds: 2, clientPopulation: 1_000 } : undefined);
    let checked = 0;
    for (const phase of phases) {
      for (const tick of run(writer, phase.lambda, phase.seconds)) {
        expect(tick.activeSessions).toBeCloseTo(
          tick.servedRequestsPerSec * tick.latencySeconds,
          9,
        );
        checked += 1;
      }
    }
    expect(checked).toBe(phases.reduce((total, phase) => total + phase.seconds / DT, 0));
  });

  it('ρ<1 の L が M/M/c の閉形式と一致する（こちらが本物の検証）', () => {
    // L = a + Lq = λ/μ + C(c,a)·ρ/(1−ρ)。
    // 実装が使っている Erlang B の漸化式ではなく、教科書の階乗の直接形で書き下す。
    // 実装と独立な経路なので、「同じ間違いを 2 回する」を避けられる。
    function textbookActiveSessions(lambda: number): number {
      const a = lambda / SERVICE_RATE;
      const rho = a / VCPU;
      let factorial = 1;
      let sum = 0;
      for (let k = 0; k < VCPU; k += 1) {
        if (k > 0) factorial *= k;
        sum += a ** k / factorial;
      }
      const tail = a ** VCPU / (factorial * VCPU * (1 - rho));
      const probabilityOfWaiting = tail / (sum + tail);
      return a + (probabilityOfWaiting * rho) / (1 - rho);
    }

    for (const rho of [0.5, 0.7, 0.8, 0.9, 0.95, 0.98]) {
      const lambda = CAPACITY * rho;
      const tick = last(run(build(), lambda, 120));
      expect(tick.activeSessions).toBeCloseTo(textbookActiveSessions(lambda), 9);
    }
  });

  it('AAS が Max vCPU 線を超えるのは、行列ができたときだけ', () => {
    // Performance Insights のあのグラフの読み方をそのまま固定する。
    const safe = last(run(build(), CAPACITY * 0.5, 60));
    expect(safe.activeSessionsPerVcpu).toBeLessThan(1);

    const overloaded = last(run(build(), CAPACITY * 2, 60));
    expect(overloaded.activeSessionsPerVcpu).toBeGreaterThan(1);
    expect(overloaded.queueLength).toBeGreaterThan(0);
  });
});

describe('保存則: 累計処理数 ≤ 容量 × 経過時間', () => {
  // M1 の「無から容量を生み出していない」検証と同じ。
  // ρ≥1 では Erlang C が使えないので、健全性はこの不等式で守る。
  it.each([false, true])('再送あり=%s', (withRetry) => {
    const writer = build(withRetry ? { clientTimeoutSeconds: 2, clientPopulation: 1_000 } : undefined);
    let servedTotal = 0;
    for (const lambda of [CAPACITY * 0.3, CAPACITY * 5, CAPACITY * 0.9, CAPACITY * 50, 0]) {
      for (const tick of run(writer, lambda, 120)) {
        servedTotal += tick.servedRequestsPerSec * DT;
      }
    }
    expect(servedTotal).toBeLessThanOrEqual(CAPACITY * writer.elapsedSeconds * (1 + 1e-9));
    // 容量いっぱいまでは実際に使っている（不等式が緩すぎて自明にならないことの確認）。
    expect(servedTotal).toBeGreaterThan(CAPACITY * writer.elapsedSeconds * 0.5);
  });

  it('行列は max_connections を超えず、どれだけ過負荷でも数値が壊れない', () => {
    const writer = build({ clientTimeoutSeconds: 2, clientPopulation: 1_000 });
    for (const tick of run(writer, CAPACITY * 1_000, 1_000)) {
      expect(tick.queueLength).toBeLessThanOrEqual(MAX_CONNECTIONS);
      expect(Number.isFinite(tick.waitSeconds)).toBe(true);
      expect(Number.isFinite(tick.activeSessions)).toBe(true);
      // ⚠️ 調査 v1 はここで 1e151 まで発散した。母集団の蓋が効いていることの検査。
      expect(tick.retriedRequestsPerSec).toBeLessThanOrEqual(1_000 / 2);
    }
  });
});

describe('壁は 2 枚あり、性質が違う', () => {
  it('壁A (vCPU) は拒否せず待たせる', () => {
    // 5% だけ過負荷にする。行列は伸びるのに、エラーは長いこと 1 件も出ない。
    const ticks = run(build(), CAPACITY * 1.05, 60);
    const firstRejection = ticks.findIndex((tick) => tick.rejectedRequestsPerSec > 0);

    expect(firstRejection).toBeGreaterThan(0);
    const quietSeconds = ticks[firstRejection - 1]?.timeSeconds ?? 0;
    // わずか 5% の過負荷で、48 秒間エラーが 1 件も出ないままレイテンシが伸び続ける。
    expect(quietSeconds).toBeCloseTo(48, 1);

    // その間、レイテンシはミリ秒から秒へ伸び続けている。
    // 過負荷に入る前（ρ=0.9）の水準と比べると 100 倍以上。
    // エラー率だけ監視していると、この 48 秒は完全に無風に見える。
    const quiet = ticks[firstRejection - 1] as AuroraWriterTickResult;
    const beforeOverload = last(run(build(), CAPACITY * 0.9, 60)).waitSeconds;
    expect(quiet.rejectedRequestsPerSec).toBe(0);
    expect(quiet.waitSeconds).toBeGreaterThan(2);
    expect(quiet.waitSeconds / beforeOverload).toBeGreaterThan(100);
  });

  it('壁B (max_connections) は待合室が埋まってから拒否する', () => {
    const tick = last(run(build(), CAPACITY * 1.25, 300));
    // 占有率は受付直後のピーク基準。拒否が出ているなら必ず 1（満杯）になっている。
    // tick 末の queueLength は容量ぶん捌けた後なので 960、つまり 0.96 にしかならない。
    expect(tick.connectionUtilization).toBeCloseTo(1, 9);
    expect(tick.queueLength / MAX_CONNECTIONS).toBeCloseTo(0.96, 9);
    expect(tick.rejectedRequestsPerSec).toBeGreaterThan(0);
    // 待合室が広がっても捌ける量は 1 件も増えない。上限は性能ではなく待合室の広さ。
    expect(tick.servedRequestsPerSec).toBeCloseTo(CAPACITY, 9);
  });

  it('並置の核心: 同じ 500 q/s でスループットは DynamoDB と同じ、違いはレイテンシだけ', () => {
    // research §5 の表の Aurora 行をそのまま固定する。
    // DynamoDB: 受理 400 / 拒否 100 / 5ms、Aurora: 受理 400 / 拒否 100 / 2,646ms
    const tick = last(run(build(), 500, 300));
    expect(tick.servedRequestsPerSec).toBeCloseTo(400, 9);
    expect(tick.rejectedRequestsPerSec).toBeCloseTo(100, 9);
    expect(tick.waitSeconds * 1_000).toBeCloseTo(2_646, 0);
  });
});

/**
 * M3 の看板テスト。M1 の保存則テストに相当する。
 *
 * メタステーブル障害の定義は「**トリガーを取り除いても劣化状態が続く**」。
 * そこが決定論的なテストにそのまま落ちる。
 *
 * ⚠️ 当初の想定と違った点: **素の待ち行列はちゃんと自力で戻る。**
 * 「戻れなくなる」には再送という増幅の仕組みが要る。
 * 「行列が伸びること」と「戻れなくなること」は別の現象である。
 */
describe('メタステーブル障害（看板テスト）', () => {
  const SAFE = CAPACITY * 0.9; // ρ = 0.9。単体では安定して捌ける負荷
  const SPIKE = CAPACITY * 2.0; // ρ = 2.0。30 秒だけ入れるトリガー
  const RETRY: AuroraRetryPolicy = { clientTimeoutSeconds: 2, clientPopulation: 1_000 };

  /** 安全な負荷 → 30 秒スパイク → 安全な負荷へ戻す。戻したあとの各時点の Q を返す。 */
  function spikeAndRecover(retry?: AuroraRetryPolicy) {
    const writer = build(retry);
    run(writer, SAFE, 60);
    const afterSpike = last(run(writer, SPIKE, 30));
    const after30 = last(run(writer, SAFE, 30));
    const after300 = last(run(writer, SAFE, 270));
    return { afterSpike, after30, after300 };
  }

  it('スパイクはどちらのモデルでも同じように行列を埋める（トリガーは同じ）', () => {
    expect(spikeAndRecover().afterSpike.queueLength).toBeCloseTo(960, 6);
    expect(spikeAndRecover(RETRY).afterSpike.queueLength).toBeCloseTo(960, 6);
  });

  it('再送 OFF: 負荷を戻せば 30 秒で回復する', () => {
    const { after30, after300 } = spikeAndRecover();
    expect(after30.queueLength).toBeCloseTo(0, 6);
    expect(after30.rejectedRequestsPerSec).toBe(0);
    // 待ち時間は統計項だけの水準（ρ=0.9 なら 21.3ms）に戻る。
    expect(after30.waitSeconds * 1_000).toBeCloseTo(21.3, 1);
    expect(after300.queueLength).toBeCloseTo(0, 6);
  });

  it('再送 ON: 300 秒後も回復しない（トリガーを取り除いても劣化が続く）', () => {
    const { after30, after300 } = spikeAndRecover(RETRY);
    expect(after30.queueLength).toBeCloseTo(960, 6);
    expect(after300.queueLength).toBeCloseTo(960, 6);
    // 負荷は安全域 (360 q/s) に戻っているのに、再送が上乗せされて容量を超え続ける。
    expect(after300.demandedRequestsPerSec).toBe(SAFE);
    expect(after300.retriedRequestsPerSec).toBeGreaterThan(0);
    expect(after300.offeredRequestsPerSec).toBeGreaterThan(CAPACITY);
    expect(after300.rejectedRequestsPerSec).toBeGreaterThan(0);
    expect(after300.waitSeconds).toBeGreaterThan(2);
  });

  it('同じ負荷に安定状態と劣化状態の 2 つがある（これがメタステーブルの定義）', () => {
    // 再送を有効にしたまま、スパイクを与えずに同じ負荷を流すと何も起きない。
    // つまり劣化を引き起こしたのは負荷そのものではなく、通り過ぎたトリガーである。
    const healthy = last(run(build(RETRY), SAFE, 360));
    expect(healthy.queueLength).toBeCloseTo(0, 6);
    expect(healthy.retriedRequestsPerSec).toBe(0);

    const degraded = spikeAndRecover(RETRY).after300;
    expect(degraded.demandedRequestsPerSec).toBe(healthy.demandedRequestsPerSec);
    // 同じ負荷なのに、レイテンシは 100 倍以上違う。
    expect(degraded.waitSeconds / healthy.waitSeconds).toBeGreaterThan(100);
  });
});
