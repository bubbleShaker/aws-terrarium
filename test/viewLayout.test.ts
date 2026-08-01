import { describe, expect, it } from 'vitest';
import {
  COLUMN_SPACING,
  HEIGHT_AT_HARD_CAP,
  columnHeight,
  damp,
  gridExtent,
  gridPositions,
} from '../src/view/layout.js';

/**
 * View 層の配置計算のテスト。
 *
 * 見た目の話に見えるが、`columnHeight` は
 * 「物理上限までは線形、超えた分は圧縮」という**教材の主張そのもの**を担っている。
 * ここが壊れると、ホットパーティションの異常さが絵の上で嘘になる。
 *
 * three.js に依存しないよう色 (palette.ts) と分けてあるので、Node 上でそのまま検証できる。
 */
describe('columnHeight', () => {
  it('物理上限ちょうどで基準面の高さになる', () => {
    expect(columnHeight(1_000, 1_000)).toBe(HEIGHT_AT_HARD_CAP);
    expect(columnHeight(3_000, 3_000)).toBe(HEIGHT_AT_HARD_CAP);
  });

  it('上限までは需要に比例する', () => {
    expect(columnHeight(500, 1_000)).toBeCloseTo(HEIGHT_AT_HARD_CAP / 2, 10);
    expect(columnHeight(250, 1_000)).toBeCloseTo(HEIGHT_AT_HARD_CAP / 4, 10);
  });

  it('上限を超えたら圧縮される（が、単調増加は保つ）', () => {
    const atCap = columnHeight(1_000, 1_000);
    const double = columnHeight(2_000, 1_000);
    const hot = columnHeight(27_000, 1_000);

    expect(double).toBeGreaterThan(atCap);
    expect(hot).toBeGreaterThan(double);
    // 27 倍の需要が 27 倍の高さになってしまうと画面外に出て比較できない。
    expect(hot).toBeLessThan(atCap * 6);
  });

  it('上限の前後で不連続にならない', () => {
    expect(columnHeight(999.999, 1_000)).toBeCloseTo(columnHeight(1_000.001, 1_000), 4);
  });

  it('需要 0 や不正な上限では 0 を返す', () => {
    expect(columnHeight(0, 1_000)).toBe(0);
    expect(columnHeight(-5, 1_000)).toBe(0);
    expect(columnHeight(1_000, 0)).toBe(0);
  });
});

describe('gridPositions', () => {
  it('本数ぶんの位置を返し、中心が原点に来る', () => {
    for (const count of [1, 2, 9, 41, 50]) {
      const positions = gridPositions(count);
      expect(positions).toHaveLength(count);

      // 重心ではなく**外接矩形の中心**が原点に来る（最終行が埋まらないと重心はずれる）。
      // カメラは原点を向いているので、揃っているべきはこちら。
      const xs = positions.map((p) => p.x);
      const zs = positions.map((p) => p.z);
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 6);
      expect(Math.min(...zs) + Math.max(...zs)).toBeCloseTo(0, 6);
    }
  });

  it('柱どうしが重ならない', () => {
    const positions = gridPositions(41);
    const keys = new Set(positions.map((p) => `${p.x.toFixed(4)}:${p.z.toFixed(4)}`));
    expect(keys.size).toBe(positions.length);

    // 隣接する 2 本の間隔は柱の太さより広い。
    const first = positions[0];
    const second = positions[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(Math.abs(second.x - first.x)).toBeCloseTo(COLUMN_SPACING, 10);
  });

  it('0 本でも壊れない', () => {
    expect(gridPositions(0)).toEqual([]);
  });
});

describe('gridExtent', () => {
  it('柱が 1 本しかなくてもカメラが貼りつかない下限がある', () => {
    // big-item-trap はパーティション 1 本。下限が無いとカメラが柱に寄りすぎて
    // 頂上が画角から外れる。
    expect(gridExtent(1)).toBeGreaterThanOrEqual(6);
  });

  it('本数が増えれば広がる', () => {
    expect(gridExtent(50)).toBeGreaterThan(gridExtent(4));
  });
});

describe('damp', () => {
  it('目標へ近づく', () => {
    const next = damp(0, 10, 12, 1 / 60);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(10);
  });

  it('フレームの刻み方に依存しない（1 回 0.1 秒 ≒ 6 回 1/60 秒）', () => {
    const once = damp(0, 10, 12, 0.1);

    let stepwise = 0;
    for (let i = 0; i < 6; i += 1) stepwise = damp(stepwise, 10, 12, 0.1 / 6);

    expect(stepwise).toBeCloseTo(once, 10);
  });

  it('既に目標なら動かない', () => {
    expect(damp(5, 5, 12, 0.016)).toBeCloseTo(5, 12);
  });
});
