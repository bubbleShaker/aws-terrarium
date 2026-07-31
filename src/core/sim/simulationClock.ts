/**
 * 描画フレームとシミュレーション tick を分離する固定タイムステップ駆動。
 *
 * ブラウザの描画は 60fps 前後で**揺れる**が、シミュレーションの tick は 0.1 秒固定で進めたい。
 * これを直結する (フレーム経過秒をそのまま `table.step()` に渡す) と、
 * フレームレートが揺れただけでシミュレーション結果が変わり、
 * M1 で確保した決定論性が壊れる。
 *
 * そこで経過時間をアキュムレータに溜め、溜まった分だけ**常に同じ幅**で tick を刻む。
 *
 * このクラスを View 層 (useFrame の中) ではなく Core に置いているのは、
 * 「不規則なフレーム経過秒の列を与えても結果が変わらない」ことを
 * ブラウザ抜きの単体テストで固定できるようにするため。
 */
export interface SimulationClockConfig {
  /** 1 tick の仮想時間 (秒)。既定 0.1。 */
  readonly tickSeconds?: number;
  /**
   * 1 フレームで進める tick 数の上限。
   *
   * これが無いと、タブを裏に回して戻ってきたときに巨大な経過秒が一気に流れ込み、
   * 「遅れを取り戻すために大量の tick を回す → さらに遅れる」というスパイラルに入る。
   * 上限に当たった分の時間は**捨てる**（仮想時間が実時間から遅れることを許容する）。
   */
  readonly maxTicksPerFrame?: number;
  /** 時間倍率。0 = 一時停止、1 = 等速、2 = 倍速。 */
  readonly timeScale?: number;
}

export const DEFAULT_TICK_SECONDS = 0.1;
const DEFAULT_MAX_TICKS_PER_FRAME = 8;

export class SimulationClock {
  readonly #tickSeconds: number;
  readonly #maxTicksPerFrame: number;
  #timeScale: number;
  #accumulator = 0;
  #simulatedSeconds = 0;
  /** 上限に当たって捨てた仮想時間 (秒)。デバッグ表示用。 */
  #droppedSeconds = 0;

  constructor(config: SimulationClockConfig = {}) {
    const tickSeconds = config.tickSeconds ?? DEFAULT_TICK_SECONDS;
    const maxTicksPerFrame = config.maxTicksPerFrame ?? DEFAULT_MAX_TICKS_PER_FRAME;
    if (!Number.isFinite(tickSeconds) || tickSeconds <= 0) {
      throw new RangeError(`tickSeconds は正の有限数である必要がある: ${tickSeconds}`);
    }
    if (!Number.isInteger(maxTicksPerFrame) || maxTicksPerFrame < 1) {
      throw new RangeError(`maxTicksPerFrame は 1 以上の整数である必要がある: ${maxTicksPerFrame}`);
    }
    this.#tickSeconds = tickSeconds;
    this.#maxTicksPerFrame = maxTicksPerFrame;
    this.#timeScale = 1;
    this.timeScale = config.timeScale ?? 1;
  }

  get tickSeconds(): number {
    return this.#tickSeconds;
  }

  get timeScale(): number {
    return this.#timeScale;
  }

  set timeScale(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`timeScale は 0 以上の有限数である必要がある: ${value}`);
    }
    this.#timeScale = value;
  }

  /** 実際に刻んだ仮想時間の合計 (秒)。捨てた分は含まない。 */
  get simulatedSeconds(): number {
    return this.#simulatedSeconds;
  }

  get droppedSeconds(): number {
    return this.#droppedSeconds;
  }

  /** まだ tick 1 つに満たない端数 (秒)。 */
  get pendingSeconds(): number {
    return this.#accumulator;
  }

  /**
   * フレームの経過秒を渡して、溜まった分だけ tick を刻む。
   * `onTick` には**常に** `tickSeconds` が渡る（可変幅で呼ばれることはない）。
   *
   * @returns 実際に刻んだ tick 数
   */
  advance(realDeltaSeconds: number, onTick: (tickSeconds: number) => void): number {
    // NaN や負値は「時間が進まなかった」として無視する。
    // requestAnimationFrame の初回や、タブ復帰直後に異常値が来ることがある。
    if (!Number.isFinite(realDeltaSeconds) || realDeltaSeconds <= 0) return 0;

    this.#accumulator += realDeltaSeconds * this.#timeScale;

    let ticks = 0;
    while (this.#accumulator >= this.#tickSeconds && ticks < this.#maxTicksPerFrame) {
      this.#accumulator -= this.#tickSeconds;
      this.#simulatedSeconds += this.#tickSeconds;
      ticks += 1;
      onTick(this.#tickSeconds);
    }

    if (this.#accumulator >= this.#tickSeconds) {
      // 上限に当たった。溜まりすぎた分は捨て、端数だけ残して位相を保つ。
      const dropped = this.#accumulator - (this.#accumulator % this.#tickSeconds);
      this.#accumulator -= dropped;
      this.#droppedSeconds += dropped;
    }

    return ticks;
  }

  /** アキュムレータと計測値を初期状態へ戻す。時間倍率は維持する。 */
  reset(): void {
    this.#accumulator = 0;
    this.#simulatedSeconds = 0;
    this.#droppedSeconds = 0;
  }
}
