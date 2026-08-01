import { describe, expect, it } from 'vitest';
import {
  bigItemTrap,
  singleHotKey,
  singleHotKeyWithoutAdaptive,
  uniformAtFullCapacity,
  uniformHealthy,
  zipfWithAdaptive,
  zipfWithoutAdaptive,
} from '../src/core/scenario/dynamodb/presets.js';
import { runScenario } from '../src/core/scenario/dynamodb/runScenario.js';

/**
 * ここは「教材として言っていること」がモデル上も本当に成り立つかを固定するテスト。
 * プリセットの数値を後から触ったときに、主張が崩れたら落ちるようにしてある。
 */
describe('教材シナリオが主張どおりに振る舞う', () => {
  it('uniform: キーが均等ならスロットルは起きない', () => {
    const { summary } = runScenario(uniformHealthy);
    expect(summary.partitionCount).toBe(41);
    expect(summary.write.throttleRate).toBeLessThan(0.001);
  });

  it('uniform: プロビジョニング値いっぱいまで流すと、均等キーでも溢れる', () => {
    // ハッシュ分散のむらで最も重いパーティションが物理上限に当たる。
    // 「均等に設計したのに 100% 使えない」ことを主張どおりの負荷で検証する。
    const { summary } = runScenario(uniformAtFullCapacity);
    expect(summary.write.throttleRate).toBeGreaterThan(0.01);

    const hottest = summary.write.hottest!;
    expect(hottest.trafficShare).toBeGreaterThan(summary.idealShare);
    expect(hottest.throttleRate).toBeGreaterThan(0.05);
  });

  it('singleHot: テーブルに余裕があっても単一キーは 1,000 WCU で頭打ちになる', () => {
    const { summary } = runScenario(singleHotKey);
    // テーブル設定は uniformHealthy とまったく同じ。違うのはキーの分布だけ。
    expect(summary.partitionCount).toBe(41);
    expect(summary.write.throttleRate).toBeGreaterThan(0.5);

    const hottest = summary.write.hottest!;
    expect(hottest.trafficShare).toBeGreaterThan(0.85);
    expect(hottest.throttleRate).toBeGreaterThan(0.9);
  });

  it('singleHot: アダプティブを ON にしても結果はほとんど変わらない', () => {
    // 「ON にしても救えない」という主張は、ON/OFF を実際に比べないと検証したことにならない。
    const on = runScenario(singleHotKey).summary.write;
    const off = runScenario(singleHotKeyWithoutAdaptive).summary.write;

    expect(singleHotKey.table.capacity).toMatchObject({ adaptiveCapacity: true });
    expect(singleHotKeyWithoutAdaptive.table.capacity).toMatchObject({ adaptiveCapacity: false });
    // zipf ではフラグ 1 つで 42% → 0% になる。単一ホットキーでは何も起きない。
    expect(on.throttleRate).toBeCloseTo(off.throttleRate, 3);
    expect(on.hottest!.throttleRate).toBeCloseTo(off.hottest!.throttleRate, 3);
  });

  it('singleHot: ホットパーティションが通せた量は 1,000 WCU 相当を超えない', () => {
    const { scenario, summary } = runScenario(singleHotKey);
    const hottest = summary.write.hottest!;
    const acceptedUnitsPerSec = hottest.acceptedUnits / scenario.durationSeconds;
    expect(acceptedUnitsPerSec).toBeLessThanOrEqual(1_000 + 1e-6);
  });

  it('zipf: アダプティブ OFF だとホットパーティションが溢れる', () => {
    const { summary } = runScenario(zipfWithoutAdaptive);
    expect(summary.write.hottest!.throttleRate).toBeGreaterThan(0.2);
  });

  it('zipf: アダプティブ ON にするだけで完全に救われる', () => {
    const { summary } = runScenario(zipfWithAdaptive);
    expect(summary.write.throttleRate).toBeLessThan(0.001);
    expect(summary.write.hottest!.throttleRate).toBeLessThan(0.001);
  });

  it('zipf: 2 つのシナリオは adaptiveCapacity 以外まったく同じ設定である', () => {
    // 「フラグ 1 つの差」であることが対比の前提。ここが崩れたら教材として嘘になる。
    const strip = (scenario: typeof zipfWithoutAdaptive) => {
      const { capacity, ...rest } = scenario.table;
      const { adaptiveCapacity, ...capacityRest } =
        capacity as Extract<typeof capacity, { mode: 'provisioned' }>;
      return { adaptiveCapacity, table: { ...rest, capacity: capacityRest } };
    };
    const off = strip(zipfWithoutAdaptive);
    const on = strip(zipfWithAdaptive);

    expect(off.adaptiveCapacity).toBe(false);
    expect(on.adaptiveCapacity).toBe(true);
    expect(off.table).toEqual(on.table);
    expect(zipfWithoutAdaptive.durationSeconds).toBe(zipfWithAdaptive.durationSeconds);
    expect(zipfWithoutAdaptive.load(0)).toEqual(zipfWithAdaptive.load(0));
  });

  it('bigItemTrap: 20KB の項目では秒 600 リクエスト付近から弾かれ始める', () => {
    // このシナリオは 1 パーティション構成が前提。パーティションが 2 本になると
    // 1 本あたりの取り分が物理上限を下回り、バーストが壁を隠して観測できなくなる。
    const result = runScenario({ ...bigItemTrap, maxRecordedTicks: Number.MAX_SAFE_INTEGER });
    expect(result.summary.partitionCount).toBe(1);
    expect(result.tickSamplingInterval).toBe(1);

    const throttlingTick = result.ticks.find((tick) => tick.read.throttleRate > 0.001);
    expect(throttlingTick).toBeDefined();
    // 需要が 600 req/s を超えたあたりで初めてスロットルが始まる。
    expect(throttlingTick!.read.demandedRequestsPerSec).toBeGreaterThan(590);
    expect(throttlingTick!.read.demandedRequestsPerSec).toBeLessThan(650);
  });

  it('テーブル全体のスロットル率はホットパーティションの深刻さを隠す', () => {
    // このプロジェクトで一番実務に効く指摘。数値として成り立つことを固定しておく。
    const { summary } = runScenario(zipfWithoutAdaptive);
    const tableWide = summary.write.throttleRate;
    const hottest = summary.write.hottest!.throttleRate;
    expect(tableWide).toBeLessThan(0.15);
    expect(hottest).toBeGreaterThan(0.3);
    expect(hottest - tableWide).toBeGreaterThan(0.2);
  });
});

describe('決定論性', () => {
  it('同じシナリオを 2 回走らせると完全に同じ結果になる', () => {
    for (const scenario of [uniformHealthy, singleHotKey, zipfWithoutAdaptive, bigItemTrap]) {
      const a = runScenario(scenario);
      const b = runScenario(scenario);
      expect(a.summary).toEqual(b.summary);
      expect(a.ticks).toEqual(b.ticks);
    }
  });

  it('tick 幅を変えても累計の結論は大きく変わらない', () => {
    const coarse = runScenario({ ...singleHotKey, tickSeconds: 1 });
    const fine = runScenario({ ...singleHotKey, tickSeconds: 0.05 });
    expect(coarse.summary.write.throttleRate).toBeCloseTo(fine.summary.write.throttleRate, 2);
  });
});

describe('入力の検証', () => {
  it('tickSeconds が 0 以下なら弾く', () => {
    expect(() => runScenario({ ...uniformHealthy, tickSeconds: 0 })).toThrow(RangeError);
  });

  it('durationSeconds が 0 以下なら弾く', () => {
    expect(() => runScenario({ ...uniformHealthy, durationSeconds: 0 })).toThrow(RangeError);
  });
});
