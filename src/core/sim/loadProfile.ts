import type { Demand } from './demand.js';
import type { Rng } from './rng.js';

/**
 * 負荷プロファイル: 経過秒数を受け取って、その瞬間の需要を返す関数。
 *
 * 関数として定義しておくと、`withJitter` のように
 * 既存のプロファイルを包んで拡張できる（開放閉鎖原則）。
 * 新しい負荷パターンを足すときも、既存のコードを触らずに済む。
 */
export type LoadProfile = (timeSeconds: number) => Demand;

/** 一定の負荷を流し続ける。 */
export function constantLoad(demand: Demand): LoadProfile {
  return () => demand;
}

/**
 * `durationSeconds` かけて `from` から `to` へ線形に増やす。
 * バーストキャパシティが最初の数秒を吸収し、その後スロットルが始まる——
 * という時間変化を観測するのに使う。
 */
export function rampLoad(options: {
  readonly from: Demand;
  readonly to: Demand;
  readonly durationSeconds: number;
}): LoadProfile {
  const { from, to, durationSeconds } = options;
  if (durationSeconds <= 0) {
    throw new RangeError(`durationSeconds は正の数である必要がある: ${durationSeconds}`);
  }
  return (timeSeconds) => {
    const progress = Math.min(1, Math.max(0, timeSeconds / durationSeconds));
    return {
      readsPerSecond: lerp(from.readsPerSecond, to.readsPerSecond, progress),
      writesPerSecond: lerp(from.writesPerSecond, to.writesPerSecond, progress),
    };
  };
}

/** 一定負荷 → `spikeAt` から `spikeDurationSeconds` だけスパイク → 元に戻る。 */
export function spikeLoad(options: {
  readonly base: Demand;
  readonly spike: Demand;
  readonly spikeAtSeconds: number;
  readonly spikeDurationSeconds: number;
}): LoadProfile {
  const { base, spike, spikeAtSeconds, spikeDurationSeconds } = options;
  return (timeSeconds) =>
    timeSeconds >= spikeAtSeconds && timeSeconds < spikeAtSeconds + spikeDurationSeconds
      ? spike
      : base;
}

/**
 * 負荷に揺らぎを加える。`amplitude` は 0..1 で、0.2 なら ±20% 揺れる。
 *
 * 実トラフィックは綺麗な直線では来ないので、
 * バーストキャパシティの消費具合を現実的に見せたいときに使う。
 * 乱数は必ず seed 付きの Rng を通すので、結果は再現する。
 */
export function withJitter(profile: LoadProfile, amplitude: number, rng: Rng): LoadProfile {
  if (!(amplitude >= 0 && amplitude <= 1)) {
    throw new RangeError(`amplitude は 0..1 の範囲である必要がある: ${amplitude}`);
  }
  return (timeSeconds) => {
    const base = profile(timeSeconds);
    const factor = 1 + rng.nextInRange(-amplitude, amplitude);
    return {
      readsPerSecond: Math.max(0, base.readsPerSecond * factor),
      writesPerSecond: Math.max(0, base.writesPerSecond * factor),
    };
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
