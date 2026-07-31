import { describe, expect, it } from 'vitest';
import { allocatorFactory } from '../src/core/services/dynamodb/allocator.js';
import { CapacityLane } from '../src/core/services/dynamodb/capacityLane.js';

/**
 * 容量レーンの保存則。
 *
 * バーストキャパシティは「使わなかったキャパシティの貯金」なので、
 * **貯金ゼロから始めた場合、累計の受理量がテーブルのキャパシティ × 経過時間を超えてはならない**。
 * これは無から容量を生み出していないことの表明であり、モデルの健全性の根幹。
 *
 * 回帰の経緯:
 * アダプティブでは、あるパーティションの未使用枠が他のパーティションへ再配分される。
 * このとき「譲った側が満額の貯金も得る」と、同じ未使用容量が
 * 「再配分」と「貯金」の 2 回使われて保存則が破れる。
 * 譲った分は貯金から差し引かなければならない。
 */
describe('CapacityLane の保存則', () => {
  const partitionCount = 4;
  const tableCapacityPerSec = 2_000;
  const context = {
    partitionCount,
    tableCapacityPerSec,
    perPartitionMaxPerSec: 1_000, // 頭割りの取り分は 2,000 / 4 = 500
  };

  const build = (adaptive: boolean): CapacityLane =>
    new CapacityLane({
      ...context,
      allocatorFactory: allocatorFactory(adaptive),
      initialBurstTokens: 0,
    });

  /** 需要パターンの列を流し、累計の受理量とテーブルの総キャパシティを返す。 */
  function run(lane: CapacityLane, phases: readonly { demand: number[]; seconds: number }[]) {
    let acceptedUnits = 0;
    let elapsed = 0;
    for (const phase of phases) {
      for (let t = 0; t < phase.seconds; t += 1) {
        acceptedUnits += lane.step(phase.demand, 1).acceptedUnitsPerSec;
        elapsed += 1;
      }
    }
    return { acceptedUnits, budgetUnits: tableCapacityPerSec * elapsed };
  }

  it.each([true, false])(
    'アダプティブ %s: 貯金ゼロから始めれば、累計受理量はテーブルの総キャパシティを超えない',
    (adaptive) => {
      // 1 本だけ長時間熱くして他 3 本から枠を貰い、その後に全本を飽和させる。
      // 旧実装では、この間に他の 3 本が満額の貯金を貯めてしまい保存則が破れていた。
      const { acceptedUnits, budgetUnits } = run(build(adaptive), [
        { demand: [900, 0, 0, 0], seconds: 400 },
        { demand: [100_000, 100_000, 100_000, 100_000], seconds: 400 },
      ]);
      expect(acceptedUnits).toBeLessThanOrEqual(budgetUnits * (1 + 1e-9));
    },
  );

  it.each([true, false])(
    'アダプティブ %s: 需要が偏り続けても保存則は破れない',
    (adaptive) => {
      const phases = Array.from({ length: 20 }, (_, i) => ({
        // 熱いパーティションを順に入れ替えながら流す。
        demand: Array.from({ length: partitionCount }, (_, p) =>
          p === i % partitionCount ? 1_500 : 50,
        ),
        seconds: 60,
      }));
      const { acceptedUnits, budgetUnits } = run(build(adaptive), phases);
      expect(acceptedUnits).toBeLessThanOrEqual(budgetUnits * (1 + 1e-9));
    },
  );

  it('貯金を持たせた場合は、その分だけ超過を許す', () => {
    // 保存則の上限は「テーブルのキャパシティ × 経過時間 + 初期貯金」。
    const initialPerPartition = 50_000;
    const lane = new CapacityLane({
      ...context,
      allocatorFactory: allocatorFactory(true),
      initialBurstTokens: initialPerPartition,
    });
    const { acceptedUnits, budgetUnits } = run(lane, [
      { demand: [100_000, 100_000, 100_000, 100_000], seconds: 300 },
    ]);
    expect(acceptedUnits).toBeGreaterThan(budgetUnits);
    expect(acceptedUnits).toBeLessThanOrEqual(
      budgetUnits + initialPerPartition * partitionCount + 1e-6,
    );
  });

  it('アダプティブは、譲った側の貯金を減らす（二重計上させない）', () => {
    // 同じ「1 本だけ熱い」状況を ON/OFF で流し、他 3 本が貯めた額を比べる。
    // OFF は誰にも譲らないので満額貯まる。ON は譲った分だけ少なくなる。
    const donorsBurst = (adaptive: boolean): number => {
      const lane = build(adaptive);
      let last = lane.step([900, 0, 0, 0], 1);
      for (let t = 1; t < 200; t += 1) last = lane.step([900, 0, 0, 0], 1);
      return last.partitions.slice(1).reduce((total, p) => total + p.burstTokens, 0);
    };

    expect(donorsBurst(true)).toBeLessThan(donorsBurst(false));
  });
});
