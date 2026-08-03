/**
 * 累積到着量 A(t) の履歴。
 *
 * **最古メッセージの年齢を FIFO で厳密に求めるためだけに存在する。**
 *
 * ## なぜ Little の法則で近似してはいけないのか
 *
 * `年齢 ≈ バックログ ÷ 消化レート` と書くのが安直な実装で、定常状態では正しい。
 * しかし**それをやると SQS の看板が消える**。
 *
 * 過負荷を止めて負荷を安全域へ下げた瞬間、`Q / D` は減り始める。
 * ところが実際の最古メッセージの年齢は**伸び続ける**。
 * 先頭に居るのは過負荷の最中に積まれた古い層で、
 * 前の客が捌けても次に先頭へ来るのは**その隣の、同じくらい古いメッセージ**だからである。
 *
 * > 負荷はもう正常なのに、`ApproximateAgeOfOldestMessage` だけが伸び続ける。
 *
 * これが SQS でいちばん怖い現象であり、近似では丸ごと消えてしまう。
 * M3 で踏んだ罠と同型である（PLAN.md:「流体モデル単独では ρ=0.98 でも
 * 待ち時間が厳密に 0 になり、飽和する前から遅くなるという最も重要な現象が消える」）。
 *
 * ## やっていること
 *
 * A(t) を**区分線形の折れ線**として持つ。FIFO なので、いま先頭にいるのは
 * 通算 `departed` 件目のメッセージである。その到着時刻 t' は `A(t') = departed` を
 * 満たす点なので、折れ線を逆に引けば厳密に求まる。年齢は `t − t'`。
 *
 * ```
 * A(t) ┤          ╱────  ← 過負荷で急に立つ
 *      │      ╱───
 *      │  ╱───              departed ├──────╴ここを逆引きする
 *      └──┴───┴────── t
 *            t'      now       年齢 = now − t'
 * ```
 *
 * ## なぜ現実的なサイズに収まるのか
 *
 * 折れ線の節を持つのは**到着レートが変わった瞬間だけ**である。
 * 負荷ダイヤルは人が回すので、tick を何万回刻んでも節は数個しか増えない。
 * 保持期間 4 日を早送りで流しても同じ（`record` が同レートの区間を伸ばすだけ）。
 */

/**
 * 折れ線の節数の上限。**通常の操作では到達しない安全網**。
 *
 * 到着レートが毎 tick 変わる（負荷プロファイルを繋いだ、View がスライダーを
 * ドラッグ中に毎フレーム値を送る、など）場合にだけ効く。
 * 超えたら間引くので年齢の精度は落ちるが、無制限に伸びて
 * ブラウザのメモリを食い潰すよりはよい。
 */
export const MAX_LEDGER_NODES = 4_096;

/** 折れ線の節。`cumulative` は時刻 `time` までに到着した累計件数。 */
interface LedgerNode {
  readonly time: number;
  readonly cumulative: number;
}

export class ArrivalLedger {
  /** 節。`time` / `cumulative` ともに単調非減少であることが不変条件。 */
  #nodes: LedgerNode[] = [{ time: 0, cumulative: 0 }];
  /**
   * 直前に記録した区間の到着レート。**同じなら節を足さずに末端を伸ばす**。
   * これが節数を現実的なサイズに保っている本体。
   */
  #lastRatePerSec: number | undefined;

  /** いま保持している節の数。テストと診断用。 */
  get nodeCount(): number {
    return this.#nodes.length;
  }

  /** 記録済みの最終時刻。 */
  get latestTime(): number {
    return last(this.#nodes).time;
  }

  /** 記録済みの累計到着件数。 */
  get latestCumulative(): number {
    return last(this.#nodes).cumulative;
  }

  /**
   * 1 tick ぶんの到着を記録する。
   *
   * @param ratePerSec この tick の到着レート (件/秒)
   * @param dtSeconds  tick 幅 (秒)
   */
  record(ratePerSec: number, dtSeconds: number): void {
    const tail = last(this.#nodes);
    const node: LedgerNode = {
      time: tail.time + dtSeconds,
      cumulative: tail.cumulative + ratePerSec * dtSeconds,
    };

    // 同じレートが続いている間は 1 本の直線なので、節を足さずに末端を動かす。
    // ⚠️ 節が 1 つしかないときは伸ばせない（伸ばすと起点を失う）。
    if (ratePerSec === this.#lastRatePerSec && this.#nodes.length > 1) {
      this.#nodes[this.#nodes.length - 1] = node;
    } else {
      this.#nodes.push(node);
      this.#lastRatePerSec = ratePerSec;
    }

    if (this.#nodes.length > MAX_LEDGER_NODES) this.#coarsen();
  }

  /**
   * 時刻 `time` までに到着していた累計件数 A(time)。
   *
   * 記録の範囲外はそれぞれ端の値で飽和させる。過去側が飽和するのは
   * `prune()` で捨てた区間を指した場合で、**そこは既に全件が出ていった領域**なので
   * 端の値（＝捨てた時点の累計）を返せば呼び出し側の判定は正しくなる。
   */
  cumulativeAt(time: number): number {
    const nodes = this.#nodes;
    const head = nodes[0] as LedgerNode;
    if (time <= head.time) return head.cumulative;

    const tail = last(nodes);
    if (time >= tail.time) return tail.cumulative;

    const index = this.#segmentIndexByTime(time);
    const from = nodes[index] as LedgerNode;
    const to = nodes[index + 1] as LedgerNode;
    const span = to.time - from.time;
    if (span <= 0) return to.cumulative;
    return from.cumulative + ((time - from.time) / span) * (to.cumulative - from.cumulative);
  }

  /**
   * 通算 `cumulative` 件目のメッセージが到着した時刻。
   *
   * FIFO なので、`cumulative` に「これまでにキューから出ていった件数」を渡すと
   * **いま先頭にいるメッセージの到着時刻**になる。
   */
  timeAtCumulative(cumulative: number): number {
    const nodes = this.#nodes;
    const head = nodes[0] as LedgerNode;
    // 捨てた領域を指されたら先頭で飽和させる（`cumulativeAt` と同じ作法）。
    // `prune` の不変条件により通常は到達しないが、ここは年齢が全面的に依存する場所なので、
    // 万一崩れたときに**過去へ外挿して年齢が発散する**のを防ぐ。
    //
    // ⚠️ `head.time` を直接返さず、飽和させた値で通常の探索を通す。
    // 先頭の区間が平坦（到着の無い空白）だった場合、`head.time` は空白の**始まり**なので
    // 年齢が空白の長さぶん過大になる。探索を通せば空白の明けた時刻が返る。
    //
    // ⚠️ 飽和させた値は**探索と補間の両方**に使うこと。探索の引数にだけ掛けると、
    // 補間の分子 `cumulative − from.cumulative` が負のまま残り、
    // 過去へ外挿する（このガードが防ぐはずのものが、そのまま素通りする）。
    const clamped = Math.max(cumulative, head.cumulative);
    const index = this.#segmentIndexByCumulative(clamped);
    const from = nodes[index] as LedgerNode;
    // 末端に張り付いた（＝まだ到着していない件数を聞かれた）場合。
    if (index === nodes.length - 1) return from.time;

    const to = nodes[index + 1] as LedgerNode;
    const arrivals = to.cumulative - from.cumulative;
    // 到着が無かった区間。この件数が到着するのは次の区間の頭なので、区間の終端を返す。
    if (arrivals <= 0) return to.time;
    return from.time + ((clamped - from.cumulative) / arrivals) * (to.time - from.time);
  }

  /**
   * すでに全件が出ていった区間の節を捨てる。
   *
   * @param departed これまでにキューから出ていった累計件数（消化 + 保持期間切れ）
   */
  prune(departed: number): void {
    const index = this.#segmentIndexByCumulative(departed);
    // 先頭の節は残す。ここが「いま先頭にいるメッセージ」を含む区間の起点になる。
    if (index > 0) this.#nodes.splice(0, index);
  }

  /**
   * 節が上限を超えたときに間引く。**内側の節を 1 つおきに捨てる**。
   *
   * 両端は必ず残るので A(t) の始点・終点は狂わず、単調性も保たれる。
   * 失われるのは間引いた区間の内部の解像度だけで、年齢の誤差は
   * 統合された区間の幅で抑えられる。
   */
  #coarsen(): void {
    const nodes = this.#nodes;
    const kept: LedgerNode[] = [nodes[0] as LedgerNode];
    for (let i = 1; i < nodes.length - 1; i += 2) kept.push(nodes[i] as LedgerNode);
    kept.push(last(nodes));
    this.#nodes = kept;
    // 末端の区間が統合された可能性があるので、レートの一致判定をやり直させる。
    this.#lastRatePerSec = undefined;
  }

  /** `time` を含む区間の始点の添字。 */
  #segmentIndexByTime(time: number): number {
    return lowerBoundIndex(this.#nodes, (node) => node.time <= time);
  }

  /**
   * `cumulative` を含む区間の始点の添字。
   *
   * ⚠️ 条件を満たす**最後の**節を返すのが要点。到着が無かった平坦な区間では
   * 複数の節が同じ `cumulative` を持つので、最初の節を返すと
   * 「誰も到着していない空白期間の先頭」を掴んでしまい、年齢が過大になる。
   * その件数のメッセージが実際に到着するのは**空白が明けた瞬間**である。
   */
  #segmentIndexByCumulative(cumulative: number): number {
    return lowerBoundIndex(this.#nodes, (node) => node.cumulative <= cumulative);
  }
}

/**
 * 述語を満たす最後の要素の添字を二分探索で返す。
 * 述語は先頭から連続して真であることを前提にする（両フィールドとも単調なので成立する）。
 */
function lowerBoundIndex(nodes: readonly LedgerNode[], holds: (node: LedgerNode) => boolean): number {
  let low = 0;
  let high = nodes.length - 1;
  while (low < high) {
    // 上側に寄せて切り上げないと、条件を満たす区間で low が動かず無限ループになる。
    const mid = Math.ceil((low + high) / 2);
    if (holds(nodes[mid] as LedgerNode)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function last(nodes: readonly LedgerNode[]): LedgerNode {
  return nodes[nodes.length - 1] as LedgerNode;
}
