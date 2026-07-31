import { describe, expect, it } from 'vitest';
import { Rng, hashString } from '../src/core/sim/rng.js';
import { TokenBucket } from '../src/core/sim/tokenBucket.js';
import { constantLoad, rampLoad, spikeLoad, withJitter } from '../src/core/sim/loadProfile.js';

describe('Rng', () => {
  it('同じ seed なら同じ列を返す（決定論性の土台）', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const seriesA = Array.from({ length: 20 }, () => a.next());
    const seriesB = Array.from({ length: 20 }, () => b.next());
    expect(seriesA).toEqual(seriesB);
  });

  it('seed が違えば違う列を返す', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('[0, 1) の範囲に収まる', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('nextInRange が指定範囲に収まる', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.nextInRange(-0.2, 0.2);
      expect(value).toBeGreaterThanOrEqual(-0.2);
      expect(value).toBeLessThan(0.2);
    }
  });
});

describe('hashString', () => {
  it('同じ文字列は常に同じ値になる（キーの配置が安定する条件）', () => {
    expect(hashString('key-0')).toBe(hashString('key-0'));
    expect(hashString('key-1')).not.toBe(hashString('key-0'));
  });

  it('符号なし 32bit の範囲に収まる', () => {
    for (let i = 0; i < 200; i += 1) {
      const value = hashString(`key-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });
});

describe('TokenBucket', () => {
  it('上限を超えて貯まらない', () => {
    const bucket = new TokenBucket(100, 0);
    bucket.refill(150);
    expect(bucket.tokens).toBe(100);
  });

  it('足りないときは残っている分だけ消費して、その量を返す', () => {
    const bucket = new TokenBucket(100, 30);
    expect(bucket.consume(50)).toBe(30);
    expect(bucket.tokens).toBe(0);
  });

  it('十分あるときは要求量をそのまま消費する', () => {
    const bucket = new TokenBucket(100, 100);
    expect(bucket.consume(40)).toBe(40);
    expect(bucket.tokens).toBe(60);
  });

  it('初期値は上限で切り詰められる', () => {
    expect(new TokenBucket(100, 500).tokens).toBe(100);
    expect(new TokenBucket(100, -5).tokens).toBe(0);
  });

  it('負や 0 の要求では何も起きない', () => {
    const bucket = new TokenBucket(100, 50);
    expect(bucket.consume(0)).toBe(0);
    expect(bucket.consume(-10)).toBe(0);
    bucket.refill(-10);
    expect(bucket.tokens).toBe(50);
  });
});

describe('LoadProfile', () => {
  it('constantLoad は時刻によらず同じ値を返す', () => {
    const profile = constantLoad({ readsPerSecond: 10, writesPerSecond: 20 });
    expect(profile(0)).toEqual(profile(999));
  });

  it('rampLoad は線形に増え、終了後は上限で止まる', () => {
    const profile = rampLoad({
      from: { readsPerSecond: 0, writesPerSecond: 0 },
      to: { readsPerSecond: 100, writesPerSecond: 0 },
      durationSeconds: 10,
    });
    expect(profile(0).readsPerSecond).toBe(0);
    expect(profile(5).readsPerSecond).toBeCloseTo(50);
    expect(profile(10).readsPerSecond).toBe(100);
    expect(profile(99).readsPerSecond).toBe(100);
  });

  it('spikeLoad は指定区間だけスパイクする', () => {
    const profile = spikeLoad({
      base: { readsPerSecond: 10, writesPerSecond: 0 },
      spike: { readsPerSecond: 500, writesPerSecond: 0 },
      spikeAtSeconds: 5,
      spikeDurationSeconds: 2,
    });
    expect(profile(4).readsPerSecond).toBe(10);
    expect(profile(5).readsPerSecond).toBe(500);
    expect(profile(6.9).readsPerSecond).toBe(500);
    expect(profile(7).readsPerSecond).toBe(10);
  });

  it('withJitter は seed が同じなら同じ揺らぎを返す', () => {
    const base = constantLoad({ readsPerSecond: 100, writesPerSecond: 0 });
    const a = withJitter(base, 0.2, new Rng(1));
    const b = withJitter(base, 0.2, new Rng(1));
    const seriesA = Array.from({ length: 10 }, (_, i) => a(i).readsPerSecond);
    const seriesB = Array.from({ length: 10 }, (_, i) => b(i).readsPerSecond);
    expect(seriesA).toEqual(seriesB);
  });

  it('withJitter は指定振幅を超えない', () => {
    const base = constantLoad({ readsPerSecond: 100, writesPerSecond: 0 });
    const jittered = withJitter(base, 0.2, new Rng(5));
    for (let i = 0; i < 200; i += 1) {
      const value = jittered(i).readsPerSecond;
      expect(value).toBeGreaterThanOrEqual(80);
      expect(value).toBeLessThanOrEqual(120);
    }
  });

  it('不正な振幅は弾く', () => {
    const base = constantLoad({ readsPerSecond: 1, writesPerSecond: 0 });
    expect(() => withJitter(base, 1.5, new Rng(0))).toThrow(RangeError);
  });
});
