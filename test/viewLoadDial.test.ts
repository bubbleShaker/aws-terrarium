import { describe, expect, it } from 'vitest';
import {
  dialToRequestsPerSec,
  loadDialMaxPosition,
  loadDialValues,
  requestsPerSecToDial,
} from '../src/view/loadDial.js';

/**
 * 負荷ダイヤルの目盛り。
 *
 * 見た目の話に見えるが、**M3 の完了条件が観測できるかどうか**がここに掛かっている。
 * ダイヤルは 1 本しかないのに、両サービスの壁は 400 q/s と 40,000 WCU で 100 倍離れている。
 * 線形の目盛りだと Aurora の帯域全体が 1 目盛りに潰れ、
 * 「エラーが 1 件も出ないままレイテンシが伸び続ける区間」へダイヤルが届かない。
 */
const WRITE_MAX = 60_000;
const READ_MAX = 6_000;

describe('dialToRequestsPerSec', () => {
  it('両端はちょうど 0 と上限になる', () => {
    expect(dialToRequestsPerSec(0, WRITE_MAX)).toBe(0);
    expect(dialToRequestsPerSec(loadDialMaxPosition(WRITE_MAX), WRITE_MAX)).toBe(WRITE_MAX);
    expect(dialToRequestsPerSec(loadDialMaxPosition(READ_MAX), READ_MAX)).toBe(READ_MAX);
  });

  it('目盛りを上げると負荷も上がる（狭義単調＝同じ値の目盛りが並ばない）', () => {
    const values = loadDialValues(WRITE_MAX);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index] ?? 0).toBeGreaterThan(values[index - 1] ?? 0);
    }
  });

  it('Aurora の帯域 (300〜600 q/s) を刻める', () => {
    // ここが刻めないと、ρ をわずかに 1 の上下へ動かす実験ができない。
    // 「5% の過負荷で 48 秒間エラーが出ない」は ρ=1.05 でしか見えない現象である。
    const inBand = loadDialValues(WRITE_MAX).filter((value) => value >= 300 && value <= 600);
    expect(inBand.length).toBeGreaterThanOrEqual(10);

    // 容量ちょうど (400) と 5% 過負荷 (420) の両方に手が届く。
    expect(dialToRequestsPerSec(requestsPerSecToDial(400, WRITE_MAX), WRITE_MAX)).toBe(400);
    expect(dialToRequestsPerSec(requestsPerSecToDial(420, WRITE_MAX), WRITE_MAX)).toBe(420);
  });

  it('DynamoDB の帯域 (12,000〜60,000 req/s) も刻める', () => {
    const inBand = loadDialValues(WRITE_MAX).filter((value) => value >= 12_000);
    expect(inBand.length).toBeGreaterThanOrEqual(10);
  });

  it('目盛りの数はスライダーとして扱える範囲に収まる', () => {
    // 桁ごとに 90 個なので、上限を 10 倍にしても目盛りは 90 個しか増えない。
    // 線形だと上限に比例して爆発する（60,000 を刻み 10 で切ると 6,000 目盛り）。
    expect(loadDialMaxPosition(WRITE_MAX)).toBeLessThan(400);
    expect(loadDialMaxPosition(READ_MAX)).toBeLessThan(300);
  });

  it('どの目盛りも有効数字 2 桁の読める数字になる（ρ を暗算できるのが前提）', () => {
    for (const value of loadDialValues(WRITE_MAX)) {
      if (value === 0) continue;
      // 実装の式を写さず、**表記から**有効数字を数える。
      // 同じ式で検算すると、実装が壊れたときテストも同じ方向に壊れる。
      const significantDigits = String(value).replace(/0+$/, '').length;
      expect(significantDigits).toBeLessThanOrEqual(2);
    }
  });
});

describe('requestsPerSecToDial', () => {
  it('目盛り → 負荷 → 目盛り で元へ戻る', () => {
    for (let position = 0; position <= loadDialMaxPosition(WRITE_MAX); position += 1) {
      const value = dialToRequestsPerSec(position, WRITE_MAX);
      expect(requestsPerSecToDial(value, WRITE_MAX)).toBe(position);
    }
  });

  it('プリセットの負荷がそのままスライダーの位置になる', () => {
    // プリセットを読み込んだ直後にスライダーが別の値を指していると、
    // 掴んだ瞬間に負荷が飛ぶ（＝プリセットの数字が失われる）。
    for (const [value, max] of [
      [500, WRITE_MAX],
      [420, WRITE_MAX],
      [24_000, WRITE_MAX],
      [40_000, WRITE_MAX],
      [1_200, READ_MAX],
    ] as const) {
      expect(dialToRequestsPerSec(requestsPerSecToDial(value, max), max)).toBe(value);
    }
  });

  it('0 と不正値は目盛り 0 に落ちる', () => {
    expect(requestsPerSecToDial(0, WRITE_MAX)).toBe(0);
    expect(requestsPerSecToDial(-10, WRITE_MAX)).toBe(0);
    expect(requestsPerSecToDial(Number.NaN, WRITE_MAX)).toBe(0);
  });
});
