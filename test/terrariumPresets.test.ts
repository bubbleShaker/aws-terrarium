import { describe, expect, it } from 'vitest';
import { TerrariumDriver, type TerrariumSnapshot } from '../src/core/scenario/driver.js';
import {
  auroraSilentSlowdown,
  defaultTerrariumPreset,
  findTerrariumPreset,
  terrariumPresets,
  type TerrariumPreset,
} from '../src/core/scenario/terrariumPresets.js';

/**
 * 画面が最初に見せるシナリオが、**Issue #9 の完了条件そのものを満たしている**ことを固定する。
 *
 * ここは 3D の見た目のテストではない。並置の主張を成立させているのは
 * 「両サービスの容量が揃っていること」という**プリセットの数字**であり、
 * それが崩れたら空間をどれだけ丁寧に作っても対比が生まれない。
 *
 * `test/terrariumDriver.test.ts` が driver の振る舞いを固定しているのに対し、
 * こちらは**画面が実際に読み込む設定**でその振る舞いが出ることを固定している。
 */
function runPreset(preset: TerrariumPreset, seconds: number): TerrariumSnapshot[] {
  const driver = new TerrariumDriver({
    load: preset.load,
    dynamodb: preset.dynamodb,
    aurora: preset.aurora,
  });
  const timeline: TerrariumSnapshot[] = [];
  const frames = Math.round(seconds * 60);
  for (let frame = 0; frame < frames; frame += 1) {
    driver.advance(1 / 60);
    timeline.push(driver.snapshot());
  }
  return timeline;
}

/** その仮想時刻ちょうどの直後のスナップショット。 */
function at(timeline: readonly TerrariumSnapshot[], seconds: number): TerrariumSnapshot {
  const found = timeline.find((snapshot) => snapshot.simulatedSeconds >= seconds);
  expect(found).toBeDefined();
  if (found === undefined) throw new Error(`t=${seconds}s のスナップショットが無い`);
  return found;
}

describe('same-load-both（完了条件: スループットは同じなのにレイテンシだけ桁違い）', () => {
  const timeline = runPreset(defaultTerrariumPreset, 30);

  it('起動時に読み込まれるのはこのプリセットである', () => {
    // 最初の画面が看板でないと、完了条件は「操作すれば見える」に後退する。
    expect(defaultTerrariumPreset.name).toBe('same-load-both');
  });

  it('両サービスの容量が揃っている（これが揃わないと対比が成立しない）', () => {
    const snapshot = at(timeline, 10);
    // DynamoDB: WCU 400 / 1KB 項目 → 400 req/s。Aurora: vCPU 2 × 1/5ms → 400 q/s。
    expect(snapshot.aurora.capacityPerSec).toBe(400);
    expect(snapshot.dynamodb.write.info.hardCapUnitsPerSec).toBeGreaterThanOrEqual(400);
    expect(snapshot.dynamodb.partitionCount).toBe(1);
  });

  it('受理も拒否も完全に一致する', () => {
    const snapshot = at(timeline, 20);
    expect(snapshot.dynamodb.write.acceptedRequestsPerSec).toBeCloseTo(400, 6);
    expect(snapshot.dynamodb.write.throttledRequestsPerSec).toBeCloseTo(100, 6);
    expect(snapshot.aurora.acceptedRequestsPerSec).toBeCloseTo(400, 6);
    expect(snapshot.aurora.rejectedRequestsPerSec).toBeCloseTo(100, 6);
    // 完了量も一致する。CloudWatch に出るのはこの数字である。
    expect(snapshot.aurora.servedRequestsPerSec).toBeCloseTo(
      snapshot.dynamodb.write.acceptedRequestsPerSec,
      6,
    );
  });

  it('違いはレイテンシにしか出ない — 一桁 ms に対し 2.6 秒', () => {
    const snapshot = at(timeline, 20);
    expect(snapshot.aurora.latencyMs).toBeGreaterThan(2_600);
    expect(snapshot.aurora.latencyMs).toBeLessThan(2_700);
    // DynamoDB の一桁 ms に対して 3 桁違う。
    expect(snapshot.aurora.latencyMs / 5).toBeGreaterThan(500);
  });
});

describe('aurora-silent-slowdown（完了条件: エラー 0 のままレイテンシが伸び続ける区間）', () => {
  const timeline = runPreset(auroraSilentSlowdown, 90);

  it('ρ=1.05 — 容量 400 q/s に対し 420 q/s', () => {
    expect(auroraSilentSlowdown.load.writesPerSecond).toBe(420);
    expect(at(timeline, 5).aurora.capacityPerSec).toBe(400);
  });

  it('48 秒間、拒否が 1 件も出ない', () => {
    const silent = timeline.filter((snapshot) => snapshot.simulatedSeconds <= 47);
    for (const snapshot of silent) {
      expect(snapshot.aurora.rejectedRequestsPerSec).toBe(0);
    }
    // その後は必ず拒否が始まる（待合室が有限であることの裏返し）。
    expect(at(timeline, 60).aurora.rejectedRequestsPerSec).toBeGreaterThan(0);
  });

  it('その 48 秒の間、レイテンシは単調に伸び続ける', () => {
    const silent = timeline.filter((snapshot) => snapshot.simulatedSeconds <= 47);
    let previous = 0;
    for (const snapshot of silent) {
      expect(snapshot.aurora.latencyMs).toBeGreaterThanOrEqual(previous);
      previous = snapshot.aurora.latencyMs;
    }
    // ミリ秒から秒へ。エラー率だけ見ていたらこの間は完全に無風に見える。
    expect(at(timeline, 5).aurora.latencyMs).toBeGreaterThan(400);
    expect(at(timeline, 45).aurora.latencyMs).toBeGreaterThan(2_400);
  });

  it('同じ 5% の過負荷を DynamoDB は最初から拒否している（即座に拒否 / 待たせてから拒否）', () => {
    const early = at(timeline, 1);
    expect(early.dynamodb.write.throttledRequestsPerSec).toBeCloseTo(20, 6);
    expect(early.aurora.rejectedRequestsPerSec).toBe(0);
  });
});

describe('プリセット一覧', () => {
  it('M1 / M2 のシナリオも残っている（Aurora は既定のまま並走する）', () => {
    expect(terrariumPresets.length).toBeGreaterThan(2);
    for (const preset of terrariumPresets) {
      expect(findTerrariumPreset(preset.name)).toBe(preset);
      expect(preset.aurora.instanceClass).toBeTruthy();
    }
  });

  it('名前が重複していない（チップの選択状態が壊れる）', () => {
    const names = terrariumPresets.map((preset) => preset.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('どのプリセットも再送は既定で切ってある', () => {
    // まず「行列は自力で戻る」を見せてから、増幅を足して壊す、という順序を守る。
    for (const preset of terrariumPresets) {
      expect(preset.aurora.retry).toBeUndefined();
    }
  });
});
