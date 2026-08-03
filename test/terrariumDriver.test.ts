import { describe, expect, it } from 'vitest';
import { TerrariumDriver, type TerrariumDriverConfig } from '../src/core/scenario/driver.js';
import { defaultDynamoDbLivePreset } from '../src/core/scenario/dynamodb/livePresets.js';

/**
 * 「どちらも容量 400 q/s 相当」に揃えた並置の構成。
 *
 * - DynamoDB: 400 WCU、1KB 項目、1 パーティション、バーストの貯金ゼロ
 * - Aurora:   db.r6g.large (vCPU 2) × 5ms/クエリ = 2 ÷ 0.005 = 400 q/s
 *
 * 貯金をゼロから始めるのは、バーストがあると数分間スロットルが表面化せず
 * 「同じ拒否量」の比較にならないため。
 */
const matchedCapacityConfig: TerrariumDriverConfig = {
  load: { readsPerSecond: 0, writesPerSecond: 500 },
  dynamodb: {
    distribution: { kind: 'uniform' },
    keyCount: 500,
    capacity: {
      mode: 'provisioned',
      readCapacityUnits: 1_000,
      writeCapacityUnits: 400,
      adaptiveCapacity: true,
    },
    tableSizeGb: 1,
    itemSizeKb: 1,
    consistentRead: true,
    initialBurstTokens: 0,
  },
  aurora: { instanceClass: 'db.r6g.large' },
  // consumer 2 個 × 5ms = 400 件/秒。DynamoDB / Aurora と同容量。
  sqs: { consumerCount: 2 },
};

function makeDriver(): TerrariumDriver {
  return new TerrariumDriver(matchedCapacityConfig);
}

function advanceSeconds(driver: TerrariumDriver, seconds: number): void {
  const frames = Math.ceil(seconds * 60);
  for (let i = 0; i < frames; i += 1) driver.advance(1 / 60);
}

describe('TerrariumDriver — 時計は 1 本しかない', () => {
  it('View から個々のセッションの時計にも step にも手が届かない', () => {
    // 「時計は driver だけが持つ」を口約束で終わらせないための構造テスト。
    // ここが通らなくなったら、セッションが自前の時計を取り戻している＝
    // timeScale を片方にだけ掛けて静かにズレる余地が復活している。
    const driver = makeDriver();

    expect('clock' in driver.dynamodb).toBe(false);
    expect('clock' in driver.aurora).toBe(false);
    expect('clock' in driver.sqs).toBe(false);

    // `step` は実体としては存在する（driver が呼ぶ）が、driver 経由で受け取る型からは
    // 外してある。下の 2 行は `@ts-expect-error` が**外れたら失敗する**ので、
    // 型から `step` が復活した瞬間にこのテストが落ちる。
    // @ts-expect-error 片方だけ進める経路は型で塞がれている
    expect(typeof driver.dynamodb.step).toBe('function');
    // @ts-expect-error 片方だけ進める経路は型で塞がれている
    expect(typeof driver.aurora.step).toBe('function');
    // @ts-expect-error 片方だけ進める経路は型で塞がれている
    expect(typeof driver.sqs.step).toBe('function');
  });

  it('フレーム時間が揺れても両者の経過時間がズレない', () => {
    const driver = makeDriver();
    // 60fps・30fps・カクつき・タブ復帰級の巨大な delta を混ぜる。
    const jitter = [1 / 60, 1 / 30, 0.004, 0.25, 1 / 60, 3.0, 0.017];

    for (let i = 0; i < 200; i += 1) {
      driver.advance(jitter[i % jitter.length] ?? 1 / 60);
      // 毎フレーム、しかも厳密一致で確認する。同じ値を同じ順序で足しているだけなので
      // 丸め差すら出ないはずで、緩めると「1 tick ズレ」以外の取りこぼしを見逃す。
      expect(driver.aurora.writer.elapsedSeconds).toBe(driver.dynamodb.table.elapsedSeconds);
      expect(driver.sqs.queue.elapsedSeconds).toBe(driver.dynamodb.table.elapsedSeconds);
    }

    expect(driver.simulatedSeconds).toBe(driver.dynamodb.table.elapsedSeconds);
    expect(driver.aurora.snapshot().simulatedSeconds).toBe(
      driver.dynamodb.snapshot().simulatedSeconds,
    );
    expect(driver.sqs.snapshot().simulatedSeconds).toBe(driver.dynamodb.snapshot().simulatedSeconds);
  });

  it('timeScale を途中で変えても両者の経過時間がズレない', () => {
    // 早送りは片方にだけ掛かる経路が存在しない、というのがこのテストの主眼。
    // 時計が 2 つあると、ここで初めて（そして静かに）ズレる。
    const driver = makeDriver();

    for (const scale of [1, 20, 0, 4, 60, 1]) {
      driver.timeScale = scale;
      for (let i = 0; i < 30; i += 1) {
        driver.advance(1 / 60);
        expect(driver.aurora.writer.elapsedSeconds).toBe(driver.dynamodb.table.elapsedSeconds);
        expect(driver.sqs.queue.elapsedSeconds).toBe(driver.dynamodb.table.elapsedSeconds);
      }
    }

    expect(driver.simulatedSeconds).toBeGreaterThan(0);
  });

  it('負荷ダイヤルは 1 本で、同じ値が全員へ届く', () => {
    const driver = makeDriver();
    driver.setLoad({ writesPerSecond: 1_000 });
    driver.advance(0.1);

    expect(driver.dynamodb.latest?.write.demandedRequestsPerSec).toBeCloseTo(1_000, 10);
    expect(driver.aurora.latest?.demandedRequestsPerSec).toBeCloseTo(1_000, 10);
    expect(driver.sqs.latest?.demandedMessagesPerSec).toBeCloseTo(1_000, 10);
    expect(driver.load).toEqual({ readsPerSecond: 0, writesPerSecond: 1_000 });
  });

  it('負荷を変えてもテーブルも writer も queue も作り直されない', () => {
    // ダイヤルを回すたびに作り直されると、経過時間もバーストの貯金も待ち行列も
    // 毎回 0 に戻る＝何も観測できなくなる。
    const driver = makeDriver();
    advanceSeconds(driver, 5);
    const table = driver.dynamodb.table;
    const writer = driver.aurora.writer;
    const queue = driver.sqs.queue;

    driver.setLoad({ writesPerSecond: 2_000 });
    advanceSeconds(driver, 1);

    expect(driver.dynamodb.table).toBe(table);
    expect(driver.aurora.writer).toBe(writer);
    expect(driver.sqs.queue).toBe(queue);
    expect(driver.dynamodb.generation).toBe(0);
    expect(driver.aurora.generation).toBe(0);
    expect(driver.sqs.generation).toBe(0);
  });

  it('負荷に NaN を入れると弾かれる（Aurora の Q は一度汚れると復帰しないため）', () => {
    const driver = makeDriver();

    expect(() => driver.setLoad({ writesPerSecond: Number.NaN })).toThrow(RangeError);
    expect(() => driver.setLoad({ readsPerSecond: -1 })).toThrow(RangeError);
    expect(driver.load.writesPerSecond).toBe(500);
  });
});

describe('TerrariumDriver — M3 の核心', () => {
  it('同じ 500 q/s で受理も拒否も同じ数字。違いはレイテンシにしか出ない', () => {
    // 本プロジェクト全体で一番伝えたい 1 点。
    // CloudWatch でスループットとエラー率だけを並べたら、この 2 つは見分けがつかない。
    //
    // ⚠️ これは**平衡状態での話**である。最初の 10 秒ほどは Aurora が 500 を全部
    // 受け入れて拒否 0（待合室に空きがあるから）なのに対し、DynamoDB は最初から弾く。
    // 「同じ数字」になるのは待合室が埋まってから。
    // なお `accepted` の意味も両者で違う（DynamoDB は捌けた量 / Aurora は並べた量）。
    // 平衡では Aurora の accepted = served なので同じ土俵で比較できている。
    const driver = makeDriver();
    advanceSeconds(driver, 60);
    const { dynamodb, aurora } = driver.snapshot();

    // 受理量: どちらも容量ぶん = 400 q/s。
    expect(dynamodb.write.acceptedRequestsPerSec).toBeCloseTo(400, 6);
    expect(aurora.acceptedRequestsPerSec).toBeCloseTo(400, 6);
    expect(aurora.servedRequestsPerSec).toBeCloseTo(400, 6);

    // 拒否量: どちらも溢れたぶん = 100 q/s。理由はまったく違うのに数字は同じ。
    // DynamoDB は ProvisionedThroughputExceededException、Aurora は Too many connections。
    expect(dynamodb.write.throttledRequestsPerSec).toBeCloseTo(100, 6);
    expect(aurora.rejectedRequestsPerSec).toBeCloseTo(100, 6);

    // ── 差はここにしかない ──
    // Aurora は 960 人を待たせた状態で釣り合っている。2.6 秒待たせてから拒否している。
    expect(aurora.queueLength).toBeCloseTo(960, 6);
    expect(aurora.latencyMs).toBeCloseTo(2_651, 0);
    expect(aurora.waitMs).toBeCloseTo(2_646, 0);
    // DynamoDB 側にはそもそもレイテンシという次元が無い。
    // 即座に拒否するモデルに待ち時間の状態は要らない、という設計思想の差がそのまま型に出ている。
    expect('latencyMs' in dynamodb).toBe(false);
  });

  it('同じ 500 q/s を SQS へ流すと、三者三様の壊れ方が並ぶ（M4 の看板）', () => {
    // 過負荷時の壊れ方の三分類を、**同じ瞬間・同じ負荷**で 1 つのスナップショットに揃える。
    //
    // | | 受理 | 拒否 | 症状 |
    // |---|---|---|---|
    // | DynamoDB | 400 | 100 | 即座に拒否 |
    // | Aurora | 400 | 100 | 2.6 秒待たせてから拒否 |
    // | SQS | **500（全部）** | **0** | 何も起きない。溜まるだけ |
    const driver = makeDriver();
    advanceSeconds(driver, 60);
    const { dynamodb, aurora, sqs } = driver.snapshot();

    // 容量は 3 つとも 400 q/s に揃えてある。揃っていないと対比が成立しない。
    expect(aurora.capacityPerSec).toBe(400);
    expect(sqs.capacityPerSec).toBe(400);

    // DynamoDB / Aurora は 100 q/s を弾いているのに、SQS は 1 件も弾いていない。
    expect(dynamodb.write.throttledRequestsPerSec).toBeCloseTo(100, 6);
    expect(aurora.rejectedRequestsPerSec).toBeCloseTo(100, 6);
    expect(sqs.rejectedMessagesPerSec).toBe(0);
    expect(sqs.enqueuedMessagesPerSec).toBeCloseTo(500, 6);

    // producer 側の指標は完全に健全なまま。エラーも遅延も出ていない。
    expect(sqs.sendLatencyMs).toBe(10);
    expect(sqs.expiredMessagesPerSec).toBe(0);

    // 唯一の異常は、ここにしか出ていない。
    // 超過 100 件/秒 がそのまま積み上がり、年齢は毎秒 0.2 秒ずつ伸びる。
    const elapsed = driver.simulatedSeconds;
    expect(elapsed).toBeCloseTo(60, 0);
    expect(sqs.queueDepth).toBeCloseTo(elapsed * 100, 3);
    expect(sqs.oldestMessageAgeSeconds).toBeCloseTo(elapsed * 0.2, 3);
    expect(sqs.backlogGrowthPerSec).toBeCloseTo(100, 6);
  });

  it('エラーが 1 件も出ないままレイテンシだけが伸びる区間がある', () => {
    // ρ=1.05 のわずかな過負荷。待合室が 1,000 席あるので、最初のエラーまで数十秒かかる。
    // その間 CloudWatch のエラー率は完全な無風に見える。
    const driver = new TerrariumDriver({ ...matchedCapacityConfig, load: { readsPerSecond: 0, writesPerSecond: 420 } });

    advanceSeconds(driver, 30);
    const mid = driver.snapshot().aurora;
    expect(mid.rejectedRequestsPerSec).toBe(0); // エラーは 1 件も出ていない
    expect(mid.queueLength).toBeGreaterThan(500); // が、待合室は半分以上埋まっている
    expect(mid.latencyMs).toBeGreaterThan(1_000); // レイテンシはミリ秒から秒へ

    // そのまま流し続けると、やがて待合室が満杯になって拒否が始まる。
    advanceSeconds(driver, 30);
    const late = driver.snapshot().aurora;
    expect(late.connectionUtilization).toBeCloseTo(1, 6);
    expect(late.rejectedRequestsPerSec).toBeGreaterThan(0);
  });

  it('プリセットの負荷をそのまま全員へ流せる', () => {
    // 負荷ダイヤルは共有なので、DynamoDB 向けに選んだ数字が Aurora にも SQS にも流れる。
    // 壊れ方が三者三様に分かれること自体が見どころになる。
    const driver = new TerrariumDriver({
      load: defaultDynamoDbLivePreset.load,
      dynamodb: defaultDynamoDbLivePreset.settings,
      aurora: { instanceClass: 'db.r6g.large' },
      sqs: { consumerCount: 2 },
    });
    advanceSeconds(driver, 10);
    const { dynamodb, aurora } = driver.snapshot();

    // DynamoDB は 24,000 WCU を捌ききる（健全）。
    expect(dynamodb.write.throttleRate).toBe(0);
    // 同じ 24,000 q/s は Aurora の 400 q/s に対して 60 倍。待合室は即座に満杯。
    expect(aurora.connectionUtilization).toBeCloseTo(1, 6);
    expect(aurora.servedRequestsPerSec).toBeCloseTo(400, 6);
  });
});

describe('TerrariumDriver — 決定論性', () => {
  it('同じ設定・同じフレーム列なら 2 回走らせても完全に同じ結果になる', () => {
    const deltas = [1 / 60, 1 / 30, 0.004, 0.25, 3.0, 0.017];
    const run = (): string => {
      const driver = makeDriver();
      for (let i = 0; i < 500; i += 1) {
        driver.advance(deltas[i % deltas.length] ?? 1 / 60);
        if (i === 200) driver.setLoad({ writesPerSecond: 900 });
        if (i === 300) driver.timeScale = 20;
        if (i === 400) driver.aurora.update({ instanceClass: 'db.r6g.xlarge' });
      }
      return JSON.stringify(driver.snapshot());
    };

    expect(run()).toBe(run());
  });

  it('フレームの刻み方を変えても、同じ tick 数だけ進めば結果は 1 ビットも変わらない', () => {
    // 決定論性の本体は「実時間から切り離されていること」。
    // 60fps で回そうが 10fps で回そうが、刻んだ tick 数が同じなら結果は完全に一致する。
    //
    // ⚠️ 実時間の秒数ではなく **tick 数**を揃える。600 × (1/60) は浮動小数では
    // 10.0 ちょうどにならないので、秒数で揃えると 1 tick ずれることがある。
    // これはモデルの非決定性ではなくアキュムレータの丸めであり、
    // 実際に 1 フレーム余分に刻むかどうかが変わるだけである。
    const runTicks = (frameSeconds: number, targetTicks: number): TerrariumDriver => {
      const driver = makeDriver();
      let ticks = 0;
      while (ticks < targetTicks) ticks += driver.advance(frameSeconds);
      return driver;
    };

    const smooth = runTicks(1 / 60, 100);
    const chunky = runTicks(0.1, 100);

    expect(JSON.stringify(chunky.snapshot())).toBe(JSON.stringify(smooth.snapshot()));
  });
});
