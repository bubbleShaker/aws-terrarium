/**
 * 負荷ダイヤルの目盛り。**three.js も React も知らない純粋な計算**だけを置く。
 *
 * ## なぜ線形の range では足りないのか
 *
 * この 1 本のダイヤルが両サービスを駆動する（切り離しトグルは無い）ので、
 * 両者の面白い帯域を 1 本で覆う必要がある。ところがその 2 つは桁が違う:
 *
 * | | 壁の位置 | 見たい帯域 |
 * |---|---|---|
 * | DynamoDB | 40,000 WCU | 12,000 〜 60,000 req/s |
 * | Aurora (db.r6g.large) | **400 q/s** | 380 〜 600 q/s |
 *
 * 線形で 0〜60,000 を 120 目盛りに切ると、1 目盛りが 500 req/s になる。
 * Aurora の帯域**全体が 1 目盛りの中に潰れる**ので、
 * 「エラーが 1 件も出ないままレイテンシが伸び続ける区間」(Issue #9 の完了条件) に
 * ダイヤルが届かない。
 *
 * ## なぜ「指数の生値を丸める」ではなく梯子そのものを目盛りにするのか
 *
 * 最初は指数関数の値を読みやすく丸める形で書いたが、2 つ壊れた:
 *
 * - 低い側で 1 目盛りの変化量が丸め幅より小さくなり、**隣の目盛りが同じ値になった**
 * - 丸めた結果が 490 / 512 のような値になり、**プリセットの 500 にダイヤルが届かなかった**。
 *   プリセットを読み込んだあとスライダーを掴んだ瞬間に負荷が飛ぶ
 *
 * そこで**有効数字 2 桁の値を全部並べたものを目盛りにする**。
 * 目盛りは必ず読める数字になり（ρ = 負荷 ÷ 容量 が暗算できる）、
 * 400・420・500・1,200・24,000 といったキリのよい値には必ず手が届く。
 * 1 目盛りの変化率は桁の頭で 10%、桁の終わりで 1% と一定ではないが、
 * どの帯域でも「壁の前後を刻める」という要件は満たす。
 */

/** 目盛り 1 の値 (件/秒)。0 は目盛り 0 に別枠で置く。 */
const LOAD_DIAL_MIN = 10;

/**
 * 目盛りの値を小さい順に並べたもの。先頭は必ず 0、末尾は必ず上限。
 *
 * 上限ごとに毎回組み立てているが、要素は 300 個ほどで、
 * 呼ばれるのはスライダーの描画時だけなので素直に作り直してよい。
 */
export function loadDialValues(maxRequestsPerSec: number): number[] {
  if (!Number.isFinite(maxRequestsPerSec) || maxRequestsPerSec <= 0) return [0];
  if (maxRequestsPerSec <= LOAD_DIAL_MIN) return [0, maxRequestsPerSec];

  const values = [0];
  let value = LOAD_DIAL_MIN;
  while (value < maxRequestsPerSec) {
    values.push(value);
    value += significantStep(value);
  }
  // 末尾は上限ちょうど。「振り切ったのに上限より少し小さい」を作らない。
  if (values[values.length - 1] !== maxRequestsPerSec) values.push(maxRequestsPerSec);
  return values;
}

/** スライダーの max に渡す値。 */
export function loadDialMaxPosition(maxRequestsPerSec: number): number {
  return loadDialValues(maxRequestsPerSec).length - 1;
}

/** 目盛りの位置を負荷 (件/秒) に変換する。 */
export function dialToRequestsPerSec(position: number, maxRequestsPerSec: number): number {
  const values = loadDialValues(maxRequestsPerSec);
  if (!Number.isFinite(position) || position <= 0) return 0;
  const index = Math.min(values.length - 1, Math.round(position));
  return values[index] ?? 0;
}

/**
 * 負荷 (件/秒) に最も近い目盛りの位置。
 *
 * プリセットが持つ負荷はすべて有効数字 2 桁なので、
 * ここは必ず**その値ちょうどの目盛り**を返す。
 * プリセットを読み込んだ直後にスライダーを掴んでも負荷は動かない。
 */
export function requestsPerSecToDial(requestsPerSec: number, maxRequestsPerSec: number): number {
  if (!Number.isFinite(requestsPerSec) || requestsPerSec <= 0) return 0;
  const values = loadDialValues(maxRequestsPerSec);

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    const distance = Math.abs((values[index] ?? 0) - requestsPerSec);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * その値の桁における「有効数字 2 桁ぶん」の刻み幅。
 *
 * 100 台なら 10、1,000 台なら 100。桁が上がるたびに刻みも上がるので、
 * 目盛りの数は桁数に比例するだけで済む（線形なら上限に比例して爆発する）。
 *
 * ⚠️ 対数に微小な下駄を履かせているのは、`Math.log10(1000)` が
 * 2.9999999999999996 になる処理系があるため。そのまま切り捨てると
 * 1,000 台の刻みが 100 ではなく 10 になり、目盛りが 10 倍に増える。
 */
function significantStep(value: number): number {
  return Math.max(1, 10 ** Math.floor(Math.log10(value) + 1e-9) / 10);
}
