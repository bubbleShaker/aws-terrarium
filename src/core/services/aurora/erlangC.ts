/**
 * Erlang C — レイテンシの「統計項」。
 *
 * ## なぜ流体モデルだけでは足りないのか
 *
 * `AuroraWriter` の行列は決定論的な流体モデルなので、
 * 「到着 ≤ 容量」なら行列は 1 件も溜まらない。つまり **ρ = 0.98 でも待ち時間が厳密に 0** になる。
 * しかし現実には ρ = 0.95 の時点でレイテンシは跳ね上がっている。
 * 流体モデル単独では「**飽和する前から遅くなる**」という、
 * キャパシティ設計で最も重要な現象が丸ごと消えてしまう。
 *
 * そこで M/M/c の閉形式（Erlang C）を「ゆらぎによる待ち」として足す。
 * 総容量 400 q/s (c=2) での値:
 *
 * | ρ | 統計項 |
 * |---|---|
 * | 0.50 | 1.7 ms |
 * | 0.90 | 21.3 ms |
 * | 0.95 | 46.3 ms |
 * | 0.98 | 121.3 ms |
 *
 * > 利用率を 50% → 95% に上げると、**使う容量は 1.9 倍なのに待ち時間は 28 倍**になる。
 * > これが「サーバは 8 割で回せ」と言われる理由。
 *
 * ## 決定論性
 *
 * Erlang C は**式であってサンプリングではない**。この経路に乱数は 1 つも無く、
 * DynamoDB 側（ハッシュ分散に PRNG を使う）よりさらに強く決定論的になる。
 */

/**
 * 統計項に使う利用率 ρ の上限。
 *
 * ⚠️ **クランプは必須**。Erlang C の待ち時間は 1/(1−ρ) を含むので ρ→1 で発散する。
 * 忘れると過負荷域（ρ≥1）の数字が全部壊れる。
 * ρ≥1 の領域を担当するのは統計項ではなく背圧項なので、ここは頭打ちで構わない。
 */
export const ERLANG_C_MAX_UTILIZATION = 0.99;

/**
 * M/M/c の平均待ち時間 Wq (秒)。サービス時間そのものは含まない。
 *
 * @param servers 窓口数 c。Aurora では vCPU 本数
 * @param serviceRatePerSec 窓口 1 本の処理レート μ (件/秒)
 * @param arrivalRatePerSec 到着率 λ (件/秒)
 */
export function erlangCWaitSeconds(
  servers: number,
  serviceRatePerSec: number,
  arrivalRatePerSec: number,
): number {
  const c = Math.floor(servers);
  if (c < 1 || serviceRatePerSec <= 0) return 0;

  const utilization = clampUtilization(arrivalRatePerSec / (c * serviceRatePerSec));
  if (utilization <= 0) return 0;

  // クランプ後の ρ と辻褄が合う提供負荷を使う。
  // 生の λ のまま erlangB に渡すと、クランプした ρ との間で式が破綻する。
  const offeredLoad = utilization * c;
  const probabilityOfWaiting = erlangCProbability(c, offeredLoad, utilization);
  return probabilityOfWaiting / (c * serviceRatePerSec * (1 - utilization));
}

/** 到着した客が待たされる確率 C(c, a)。 */
function erlangCProbability(servers: number, offeredLoad: number, utilization: number): number {
  const blocking = erlangBProbability(servers, offeredLoad);
  return blocking / (1 - utilization * (1 - blocking));
}

/**
 * Erlang B の再帰形 B(c, a)。
 *
 * 教科書の直接形は a^c / c! を含むが、c = 32 (db.r6g.8xlarge) では
 * 分子・分母がともに巨大になり桁落ちする。
 * この漸化式は途中の値が常に 0..1 に収まるので数値的に安定する。
 */
function erlangBProbability(servers: number, offeredLoad: number): number {
  let blocking = 1;
  for (let k = 1; k <= servers; k += 1) {
    blocking = (offeredLoad * blocking) / (k + offeredLoad * blocking);
  }
  return blocking;
}

function clampUtilization(utilization: number): number {
  if (!Number.isFinite(utilization) || utilization <= 0) return 0;
  return Math.min(utilization, ERLANG_C_MAX_UTILIZATION);
}
