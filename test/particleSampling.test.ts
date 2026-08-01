import { describe, expect, it } from 'vitest';
import { allocateByWeight } from '../src/core/sim/particleSampling.js';
import { buildKeyWeights } from '../src/core/services/dynamodb/keyDistribution.js';

describe('allocateByWeight', () => {
  it('合計が必ず total と一致する', () => {
    // 端数が出る組み合わせ (1/3 ずつ) でも合計は崩れない。
    expect(allocateByWeight([1 / 3, 1 / 3, 1 / 3], 400).reduce((a, b) => a + b, 0)).toBe(400);
    expect(allocateByWeight([0.9, 0.05, 0.05], 7).reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('重みに比例して配る', () => {
    expect(allocateByWeight([0.5, 0.25, 0.25], 100)).toEqual([50, 25, 25]);
  });

  it('正規化されていない重みでも扱える', () => {
    expect(allocateByWeight([2, 1, 1], 100)).toEqual([50, 25, 25]);
  });

  it('単一ホットキーでは粒子もほぼ 1 本に集まる', () => {
    const weights = buildKeyWeights({ kind: 'singleHot', hotRatio: 0.9 }, 50);
    const counts = allocateByWeight([...weights], 400);
    expect(counts[0]).toBe(360);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(400);
  });

  it('退化したケースで壊れない', () => {
    expect(allocateByWeight([], 100)).toEqual([]);
    expect(allocateByWeight([1, 1], 0)).toEqual([0, 0]);
    // 重みが全部 0 なら誰にも配らない (0 除算を作らない)。
    expect(allocateByWeight([0, 0], 10)).toEqual([0, 0]);
    expect(() => allocateByWeight([1], -1)).toThrow(RangeError);
    expect(() => allocateByWeight([1], 1.5)).toThrow(RangeError);
  });

  it('同じ入力なら常に同じ配分 (決定論的)', () => {
    const weights = [0.2, 0.2, 0.2, 0.2, 0.2];
    expect(allocateByWeight(weights, 7)).toEqual(allocateByWeight(weights, 7));
  });
});
