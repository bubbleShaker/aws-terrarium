import { describe, expect, it } from 'vitest';
import { SimulationClock } from '../src/core/sim/simulationClock.js';
import { DynamoDbTable } from '../src/core/services/dynamodb/table.js';
import { buildKeyWeights } from '../src/core/services/dynamodb/keyDistribution.js';
import { Rng } from '../src/core/sim/rng.js';

function collectTickWidths(clock: SimulationClock, frames: readonly number[]): number[] {
  const widths: number[] = [];
  for (const frame of frames) clock.advance(frame, (dt) => widths.push(dt));
  return widths;
}

describe('SimulationClock', () => {
  it('溜まった分だけ固定幅で刻む', () => {
    const clock = new SimulationClock({ tickSeconds: 0.1 });
    expect(collectTickWidths(clock, [0.25])).toEqual([0.1, 0.1]);
    expect(clock.pendingSeconds).toBeCloseTo(0.05, 10);
    // 端数は次のフレームへ持ち越される。
    expect(collectTickWidths(clock, [0.06])).toEqual([0.1]);
  });

  it('1 フレームで刻む tick 数に上限があり、超過ぶんは捨てる', () => {
    const clock = new SimulationClock({ tickSeconds: 0.1, maxTicksPerFrame: 3 });
    // タブを 10 秒裏に回して戻ってきた想定。100 tick ぶん溜まっている。
    const widths = collectTickWidths(clock, [10]);
    expect(widths).toHaveLength(3);
    expect(clock.droppedSeconds).toBeCloseTo(9.7, 10);
    // 捨てた後もアキュムレータに残骸が残らない（残ると次フレームも上限に張り付く）。
    expect(clock.pendingSeconds).toBeLessThan(0.1);
  });

  it('timeScale が 0 なら止まり、2 なら倍の速さで進む', () => {
    const paused = new SimulationClock({ timeScale: 0 });
    expect(collectTickWidths(paused, [1])).toHaveLength(0);

    // 1.03 秒 × 倍速 = 2.06 秒ぶん → 20 tick。
    // ちょうど tick 境界になる値 (1.0 → 2.0) を避けているのは、
    // アキュムレータの引き算に浮動小数点の誤差が乗り、境界上では 1 tick ずれうるため。
    const fast = new SimulationClock({ tickSeconds: 0.1, timeScale: 2, maxTicksPerFrame: 100 });
    expect(collectTickWidths(fast, [1.03])).toHaveLength(20);
  });

  it('NaN・負値・0 のフレーム経過秒は無視する', () => {
    const clock = new SimulationClock();
    expect(collectTickWidths(clock, [Number.NaN, -1, 0])).toHaveLength(0);
    expect(clock.pendingSeconds).toBe(0);
  });

  it('不正な設定を拒否する', () => {
    expect(() => new SimulationClock({ tickSeconds: 0 })).toThrow(RangeError);
    expect(() => new SimulationClock({ maxTicksPerFrame: 0 })).toThrow(RangeError);
    expect(() => new SimulationClock({ timeScale: -1 })).toThrow(RangeError);
  });
});

describe('決定論性: フレームレートが揺れても結果が変わらない', () => {
  const tableConfig = {
    capacity: {
      mode: 'provisioned',
      readCapacityUnits: 1_000,
      writeCapacityUnits: 20_000,
      adaptiveCapacity: true,
    },
    tableSizeGb: 500,
    itemSizeKb: 1,
    consistentRead: true,
    keyWeights: buildKeyWeights({ kind: 'zipf', skew: 0.7 }, 500),
  } as const;

  /** クロック越しに一定の負荷を流し、各 tick の受理量を並べる。 */
  function run(frames: readonly number[]): number[] {
    const table = new DynamoDbTable(tableConfig);
    const clock = new SimulationClock({ tickSeconds: 0.1, maxTicksPerFrame: 1_000 });
    const accepted: number[] = [];
    for (const frame of frames) {
      clock.advance(frame, (dt) => {
        accepted.push(table.step({ readsPerSecond: 0, writesPerSecond: 12_000 }, dt).write.acceptedRequestsPerSec);
      });
    }
    return accepted;
  }

  it('60fps 一定と、揺れるフレームで、tick 列が完全に一致する', () => {
    // 合計 10.083 秒。tick 境界 (0.1 の倍数) をまたいだ半端な長さにしてある。
    // ちょうど境界だと、浮動小数点の誤差だけで tick 数が 1 ずれる不安定なテストになる。
    const steady = Array.from({ length: 605 }, () => 1 / 60);

    // 実ブラウザ相当の揺れ (フレーム落ちを含む) を作る。合計時間は steady と揃える。
    const rng = new Rng(20260801);
    const jittery: number[] = [];
    let remaining = steady.reduce((sum, f) => sum + f, 0);
    while (remaining > 0) {
      const frame = Math.min(remaining, rng.nextInRange(0.004, 0.05));
      jittery.push(frame);
      remaining -= frame;
    }

    const a = run(steady);
    const b = run(jittery);

    expect(b).toEqual(a);
    // 念のため、実際に刻まれていることも確かめる (両方 0 件では一致して当然)。
    expect(a.length).toBeGreaterThan(90);
  });

  it('1 フレームでまとめて進めても、細かく進めても同じ', () => {
    expect(run([10.05])).toEqual(run(Array.from({ length: 1_005 }, () => 0.01)));
  });
});
