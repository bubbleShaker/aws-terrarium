import { describe, expect, it } from 'vitest';
import {
  ERLANG_C_MAX_UTILIZATION,
  erlangCWaitSeconds,
} from '../src/core/services/aurora/erlangC.js';

/**
 * 統計項の検証。
 *
 * ここでは**実装とは別の式**を使って照合する。
 * 本体は数値的に安定な Erlang B の漸化式を使っているので、
 * テスト側は教科書どおりの階乗の直接形を書き下す。
 * 同じ式を 2 回書いても「同じ間違いを 2 回する」だけで検証にならない。
 */

/** 教科書の直接形: C(c,a) = [a^c/(c!(1−ρ))] / [Σ_{k<c} a^k/k! + a^c/(c!(1−ρ))] */
function textbookErlangCWaitSeconds(c: number, mu: number, lambda: number): number {
  const a = lambda / mu;
  const rho = a / c;
  let factorial = 1;
  let sum = 0;
  for (let k = 0; k < c; k += 1) {
    if (k > 0) factorial *= k;
    sum += a ** k / factorial;
  }
  const tail = a ** c / (factorial * c * (1 - rho));
  const probabilityOfWaiting = tail / (sum + tail);
  return probabilityOfWaiting / (c * mu - lambda);
}

describe('Erlang C（レイテンシの統計項）', () => {
  // db.r6g.large 相当: vCPU 2、1 クエリ 5ms → μ = 200 q/s/core、総容量 400 q/s
  const vcpu = 2;
  const mu = 200;
  const capacity = vcpu * mu;

  it.each([0.5, 0.7, 0.8, 0.9, 0.95, 0.98])(
    'ρ=%s で教科書の直接形と一致する',
    (rho) => {
      const lambda = capacity * rho;
      expect(erlangCWaitSeconds(vcpu, mu, lambda)).toBeCloseTo(
        textbookErlangCWaitSeconds(vcpu, mu, lambda),
        12,
      );
    },
  );

  it('調査で実測した値を再現する（飽和前から遅くなる）', () => {
    // research/260801-aurora-queueing-model.md §4-1 の表。
    // 利用率 50% → 95% で、使う容量は 1.9 倍なのに待ち時間は 28 倍になる。
    const expectedMs: Record<string, number> = {
      '0.5': 1.7,
      '0.7': 4.8,
      '0.8': 8.9,
      '0.9': 21.3,
      '0.95': 46.3,
      '0.98': 121.3,
    };
    for (const [rho, ms] of Object.entries(expectedMs)) {
      const waitMs = erlangCWaitSeconds(vcpu, mu, capacity * Number(rho)) * 1_000;
      expect(waitMs).toBeCloseTo(ms, 1);
    }

    const ratio =
      erlangCWaitSeconds(vcpu, mu, capacity * 0.95) / erlangCWaitSeconds(vcpu, mu, capacity * 0.5);
    expect(ratio).toBeGreaterThan(25);
  });

  it('ρ は 0.99 でクランプされ、過負荷でも有限に留まる', () => {
    // ⚠️ ここが壊れると過負荷域の数字が全部壊れる。1/(1−ρ) は ρ→1 で発散する。
    const clamped = erlangCWaitSeconds(vcpu, mu, capacity * ERLANG_C_MAX_UTILIZATION);
    for (const rho of [1.0, 1.05, 2, 10, 1_000]) {
      const wait = erlangCWaitSeconds(vcpu, mu, capacity * rho);
      expect(Number.isFinite(wait)).toBe(true);
      expect(wait).toBeCloseTo(clamped, 12);
    }
    // クランプ点の値そのものも固定しておく（調査の 2,646ms の内訳 246ms 側）。
    expect(clamped * 1_000).toBeCloseTo(246.3, 1);
  });

  it('負荷が無ければ待ち時間は 0', () => {
    expect(erlangCWaitSeconds(vcpu, mu, 0)).toBe(0);
    expect(erlangCWaitSeconds(vcpu, mu, -100)).toBe(0);
  });

  it('窓口が多いほど、同じ利用率でも待ち時間は短い', () => {
    // 「vCPU を増やすほうが待合室を広げるより効く」の根拠。
    // 総容量を揃えたまま窓口だけ増やす（μ を反比例させる）。
    const waits = [2, 4, 8, 16, 32].map((c) =>
      erlangCWaitSeconds(c, capacity / c, capacity * 0.9),
    );
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]).toBeLessThan(waits[i - 1] as number);
    }
    // c=32 でも数値が壊れない（階乗の直接形なら桁落ちする領域）。
    expect(Number.isFinite(waits[waits.length - 1] as number)).toBe(true);
    expect(waits[waits.length - 1] as number).toBeGreaterThan(0);
  });
});
