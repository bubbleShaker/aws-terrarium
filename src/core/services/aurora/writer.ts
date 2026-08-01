import type { Demand } from '../../sim/demand.js';
import { erlangCWaitSeconds } from './erlangC.js';
import {
  AURORA_INSTANCE_CLASSES,
  type AuroraInstanceClass,
  type AuroraInstanceSpec,
  AURORA_DEFAULT_SERVICE_TIME_MS,
  auroraInstanceSpec,
} from './instanceClasses.js';

/**
 * 再送ポリシー。**メタステーブル障害の本体**。
 *
 * 調査で分かったこと: **素の待ち行列はちゃんと自力で戻る**。
 * 安全な負荷 → スパイク → 安全な負荷へ戻すと、再送が無ければ行列は掃ける。
 * 戻れなくなるのは**再送という増幅の仕組みが加わったときだけ**。
 * つまり「行列が伸びること」と「戻れなくなること」は別の現象である。
 *
 * ## 増幅の正体
 *
 * クライアントが timeout で諦めて再送しても、**サーバはそれを知らないので元の仕事も処理する**。
 * 1 リクエストぶんの容量で 0 件ぶんの成果しか出ない — これが無駄仕事＝増幅。
 * 行列が空かない限りレイテンシは timeout を超え続けるので、
 * 負荷を下げても再送が止まらず、劣化状態が自分で自分を維持する（sustaining effect）。
 *
 * ## ⚠️ 有限の母集団で閉じること
 *
 * 調査 v1 で、再送を「行列長に単純比例」と書いたら出力が **1e151** まで発散した。
 * 再送しうるのは**返事を待っているクライアントだけ**なので、母集団は必ず有限である。
 *
 * 発散を止めているのは `Q ≤ maxConnections` という**構造的な上界**であり、
 * これによって再送レートは `maxConnections / clientTimeoutSeconds` を超えられない。
 * `clientPopulation` はそれをさらに絞るダイヤルで、
 * 抑えるのは**同時に諦めている件数**であってレートそのものではない
 * （`clientTimeoutSeconds` を極端に短くすれば再送レートはいくらでも上げられる。
 * ただし有限には留まる）。
 */
export interface AuroraRetryPolicy {
  /** クライアントが返事を諦めて再送するまでの時間 (秒)。 */
  readonly clientTimeoutSeconds: number;
  /** 同時に再送しうるクライアント数の上限。母集団を有限に閉じる蓋。 */
  readonly clientPopulation: number;
}

export interface AuroraWriterConfig {
  readonly instanceClass: AuroraInstanceClass;
  /**
   * 1 クエリの平均処理時間 (ms)。省略時 5ms。
   * ⚠️ このモデル唯一の仮定値（公式の値は存在しない）。
   */
  readonly serviceTimeMs?: number | undefined;
  /** 省略すると再送なし（= 自力で戻れるモデル）。 */
  readonly retry?: AuroraRetryPolicy | undefined;
}

export interface AuroraWriterTickResult {
  readonly timeSeconds: number;

  /** 負荷ダイヤルが出している素の需要 λ (件/秒)。再送を含まない。 */
  readonly demandedRequestsPerSec: number;
  /** 再送で上乗せされた分 (件/秒)。増幅の大きさがそのまま見える。 */
  readonly retriedRequestsPerSec: number;
  /** 実際に writer へ到着した量 (件/秒) = 需要 + 再送。 */
  readonly offeredRequestsPerSec: number;

  /** 壁B を通って待合室に入れた量 (件/秒)。 */
  readonly acceptedRequestsPerSec: number;
  /** 壁B であふれた量 (件/秒)。`Too many connections`。 */
  readonly rejectedRequestsPerSec: number;
  /** 壁A を抜けて完了した量 (件/秒)。過負荷でも容量で一定になる。 */
  readonly servedRequestsPerSec: number;

  /** 待ち行列長 Q。tick をまたいで持続する、このモデル最初の滞留状態。 */
  readonly queueLength: number;
  /**
   * この tick に待合室が最も埋まった時点の占有率。**1 に達した瞬間から拒否が始まる**。
   *
   * 基準にするのは受付直後のピークであって tick 末の `queueLength` ではない。
   * tick 末は容量ぶん捌けた後なので、`queueLength / maxConnections` は
   * 拒否が出ていても 1 に届かない（dt=0.1 なら 0.96 で頭打ち）。
   */
  readonly connectionUtilization: number;

  /** 背圧項: いま並んでいる列が掃けるまでの時間 (秒)。過負荷と過渡状態を担当。 */
  readonly backpressureSeconds: number;
  /** 統計項: Erlang C (秒)。飽和以前のゆらぎを担当。 */
  readonly statisticalSeconds: number;
  /** 待ち時間 W = 背圧項 + 統計項 (秒)。 */
  readonly waitSeconds: number;
  /** クライアントから見たレイテンシ (秒) = W + 処理時間。 */
  readonly latencySeconds: number;

  /**
   * L（系内客数）。Performance Insights の **AAS / DBLoad** と同じもの。
   * Little の法則 `L = λW` が全 tick で成立する。
   */
  readonly activeSessions: number;
  /**
   * AAS ÷ Max vCPU。Performance Insights のあのグラフの読み方そのもの。
   * **1 を超えたら待ち行列ができている**。
   */
  readonly activeSessionsPerVcpu: number;
  /** 提供負荷 ÷ 総容量。統計項が使う ρ（こちらはクランプ前の生の値）。 */
  readonly offeredLoadRatio: number;
}

/**
 * Aurora writer 1 台の待ち行列モデル。
 *
 * ## 壁は 2 枚あり、性質が違う
 *
 * | | 壁A: vCPU 本数 | 壁B: max_connections |
 * |---|---|---|
 * | 挙動 | **拒否せず待たせる**（M/M/c の窓口数 c） | **拒否する**（`Too many connections`） |
 * | db.r6g.large | **2** | **1,000** |
 *
 * 公式が「プロセス数が vCPU 数を超えると並び始め、性能が落ちる」と明言しているので、
 * 壁A は M/M/c の c そのものとして扱ってよい。
 *
 * ## この 2 枚の距離が生む現象
 *
 * 並ぶ場所が捌ける本数の 500 倍広いので、Aurora は
 * **エラーを 1 件も出さないまま、ひたすら遅くなる**ことができる。
 * わずか 5% の過負荷 (ρ=1.05) で、最初のエラーが出るまで **48 秒**かかる。
 * その間にレイテンシはミリ秒から秒へ伸び続けている。
 * エラー率だけ監視していると、この 48 秒は完全に無風に見える。
 *
 * DynamoDB と並べると、これがそのまま教材になる — 同じ 500 q/s を
 * どちらも容量 400 q/s 相当のサービスへ流すと:
 *
 * | | 受理 | 拒否 | レイテンシ |
 * |---|---|---|---|
 * | DynamoDB | 400 q/s | 100 q/s | **5 ms** |
 * | Aurora | 400 q/s | 100 q/s | **2,646 ms** |
 *
 * > **スループットの数字は完全に同一。違いはレイテンシにしか出ない。**
 *
 * ## モデルの健全性の守り方
 *
 * 閉形式（Erlang C）は**エンジンではなくテストオラクル**に使う。
 * ρ<1 でだけ理論値に照合し、理論値が使えない ρ≥1 は保存則
 * （累計処理数 ≤ 容量 × 経過時間）で守る。M1 のバースト検証と同じ構造。
 *
 * ## スコープ外（意図的に入れていないもの）
 *
 * - **USL による容量劣化** — α, β に公式の根拠が無く校正できない。
 *   推測値でモデルを複雑にすると教材の信頼性が落ちる
 * - **RDS Proxy の 3 段目のキュー** — 壁A/B だけで主題は成立する
 * - **Kingman のばらつきダイヤル** — 価値は高いが、まず基本形を通す
 */
export class AuroraWriter {
  readonly #spec: AuroraInstanceSpec;
  readonly #serviceTimeSeconds: number;
  /** 窓口 1 本の処理レート μ (件/秒)。 */
  readonly #serviceRatePerSec: number;
  /** 総容量 c × μ (件/秒)。 */
  readonly #capacityPerSec: number;
  #retry: AuroraRetryPolicy | undefined;

  /** 待ち行列長 Q。M2 までのモデルには無かった「増えも減りもする滞留状態」。 */
  #queue = 0;
  /**
   * 直前 tick のレイテンシ。再送の判定に使う。
   *
   * 前の tick の値を見るのは、クライアントが「返事が来ない」と気づけるのは
   * 待たされた**後**だからである。同 tick 内で自分を参照させると因果が崩れる。
   */
  #latencySeconds = 0;
  #elapsedSeconds = 0;

  constructor(config: AuroraWriterConfig) {
    const serviceTimeMs = config.serviceTimeMs ?? AURORA_DEFAULT_SERVICE_TIME_MS;
    validateConfig(config, serviceTimeMs);

    this.#spec = auroraInstanceSpec(config.instanceClass);
    this.#serviceTimeSeconds = serviceTimeMs / 1_000;
    this.#serviceRatePerSec = 1 / this.#serviceTimeSeconds;
    this.#capacityPerSec = this.#spec.vcpu * this.#serviceRatePerSec;
    // setter を通す。検証規則が 2 箇所に分かれると、片方だけ緩む。
    this.retryPolicy = config.retry;
  }

  /** 壁A。Performance Insights の **Max vCPU 線**にあたる。 */
  get maxVcpu(): number {
    return this.#spec.vcpu;
  }

  /** 壁B。待合室の広さであって、性能の上限ではない。 */
  get maxConnections(): number {
    return this.#spec.maxConnections;
  }

  /** 総容量 c × μ (件/秒)。過負荷でも増えも減りもしない。 */
  get capacityPerSec(): number {
    return this.#capacityPerSec;
  }

  get serviceTimeSeconds(): number {
    return this.#serviceTimeSeconds;
  }

  get queueLength(): number {
    return this.#queue;
  }

  get retryPolicy(): AuroraRetryPolicy | undefined {
    return this.#retry;
  }

  /**
   * 再送ポリシーを差し替える。**待ち行列 Q は持ち越す**。
   *
   * 諸元 (vCPU / max_connections / サービス時間) は構築時に確定させたままで、
   * ここだけを可変にしているのは、再送が**サーバの設定ではなくクライアントの振る舞い**だからである。
   * クライアント側を変えてもサーバに並んでいる客は消えない。
   *
   * この非対称性がそのまま教材になる — メタステーブル障害から抜け出せるのは
   * 負荷を下げたときではなく、**増幅（再送）を断ち切ったとき**である。
   * 差し替えでリセットしてしまうと、その因果が「リセットしたから直った」に見えてしまう。
   */
  set retryPolicy(policy: AuroraRetryPolicy | undefined) {
    if (policy !== undefined) {
      requirePositive(policy.clientTimeoutSeconds, 'clientTimeoutSeconds');
      requirePositive(policy.clientPopulation, 'clientPopulation');
    }
    this.#retry = policy;
  }

  get elapsedSeconds(): number {
    return this.#elapsedSeconds;
  }

  /** シミュレーションを 1 tick 進める。 */
  step(demand: Demand, dtSeconds: number): AuroraWriterTickResult {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      throw new RangeError(`dtSeconds は正の有限数である必要がある: ${dtSeconds}`);
    }

    // reader を足していない単一 writer 構成なので、読み取りも writer へ来る。
    // 落とすと「同じ負荷を両方へ流す」という並置の前提が崩れるため、合算して受ける。
    //
    // ⚠️ NaN を必ずここで止める。Q は tick をまたいで持続する状態なので、
    // 一度でも NaN が混じると以降どんな正常な入力を流しても復帰しない
    // （DynamoDB 側もバーストの貯金は tick をまたぐが、あちらは
    //   1 パーティションのトークンが 1 つ壊れるだけで、行列のように全体を巻き込まない）。
    const demanded = finiteNonNegative(demand.readsPerSecond) + finiteNonNegative(demand.writesPerSecond);
    const retried = this.#retryRatePerSec();
    const offered = demanded + retried;

    // ── 壁B: max_connections。待合室に空きがある分だけ受け付ける ──
    const inflow = offered * dtSeconds;
    const room = Math.max(0, this.#spec.maxConnections - this.#queue);
    const admitted = Math.min(inflow, room);
    const rejected = inflow - admitted;
    this.#queue += admitted;
    // 受付直後がこの tick の待合室のピーク。ここが満杯になった瞬間から拒否が始まる。
    const peakQueue = this.#queue;

    // ── 壁A: vCPU 本数。拒否はせず、捌ける本数だけ捌く ──
    const served = Math.min(this.#queue, this.#capacityPerSec * dtSeconds);
    this.#queue -= served;

    // 完了レート。行列が残っている間は必ず総容量に張り付く
    // （残るということは容量ぶん捌ききったということなので）。
    const throughput = served / dtSeconds;

    // ── レイテンシは 2 項の和 ──
    // ρ<1 では背圧項が 0 になり統計項だけが効く。ρ≥1 では背圧項が主役になる。
    // ただし ρ≥1 でも統計項が消えるわけではない: クランプ値に張り付いて一定の下駄になる
    // （ρ=∞ でも 246ms。看板の 2,646ms のうち 9% はこの下駄）。
    // ⚠️ したがって ERLANG_C_MAX_UTILIZATION は過負荷域の数値に直接効く。動かすと看板の値がズレる。
    const backpressureSeconds = this.#queue / this.#capacityPerSec;
    const statisticalSeconds = erlangCWaitSeconds(
      this.#spec.vcpu,
      this.#serviceRatePerSec,
      offered,
    );
    const waitSeconds = backpressureSeconds + statisticalSeconds;
    const latencySeconds = waitSeconds + this.#serviceTimeSeconds;

    // L を λW から逆算せず、**状態から独立に組み立てる**（λW で定義すると恒真式になる）。
    // なお更新式の形から `L ≡ λW` は到達可能な全状態で代数的に成立する
    // （tick 末は必ず「Q=0」か「throughput=総容量」のどちらかになるため）。
    // つまりテスト側の全 tick 検査は、モデルの検証ではなく **3 項のどれかを取り違えた場合の回帰ガード**。
    // 本当の検証は ρ<1 で閉形式 L = a + C·ρ/(1−ρ) と突き合わせる側が担う。
    const activeSessions =
      this.#queue + // 背圧で並んでいる分
      throughput * statisticalSeconds + // ゆらぎで並んでいる分
      throughput * this.#serviceTimeSeconds; // いま vCPU 上で走っている分

    this.#latencySeconds = latencySeconds;
    this.#elapsedSeconds += dtSeconds;

    return {
      timeSeconds: this.#elapsedSeconds,
      demandedRequestsPerSec: demanded,
      retriedRequestsPerSec: retried,
      offeredRequestsPerSec: offered,
      acceptedRequestsPerSec: admitted / dtSeconds,
      rejectedRequestsPerSec: rejected / dtSeconds,
      servedRequestsPerSec: throughput,
      queueLength: this.#queue,
      connectionUtilization: peakQueue / this.#spec.maxConnections,
      backpressureSeconds,
      statisticalSeconds,
      waitSeconds,
      latencySeconds,
      activeSessions,
      activeSessionsPerVcpu: activeSessions / this.#spec.vcpu,
      offeredLoadRatio: offered / this.#capacityPerSec,
    };
  }

  /**
   * この tick に再送で上乗せされる量 (件/秒)。
   *
   * 諦めたクライアントは再送するが、**サーバは元の仕事も処理する**ので、
   * 再送は行列から引かずに到着へ足す。この無駄仕事が増幅の正体。
   */
  #retryRatePerSec(): number {
    const retry = this.#retry;
    if (retry === undefined) return 0;

    const { clientTimeoutSeconds, clientPopulation } = retry;
    if (this.#latencySeconds <= clientTimeoutSeconds) return 0;

    // FIFO で並んでいる客の待ち時間は 0〜latency に散っているので、
    // timeout を超えて痺れを切らしているのはそのうち (1 − timeout/latency)。
    const givenUpFraction = 1 - clientTimeoutSeconds / this.#latencySeconds;
    // ⚠️ 母集団の蓋。これが無いと再送が再送を呼んで発散する。
    const givenUp = Math.min(this.#queue * givenUpFraction, clientPopulation);
    // 1 クライアントは timeout に 1 回しか再送しない。
    return givenUp / clientTimeoutSeconds;
  }
}

function validateConfig(config: AuroraWriterConfig, serviceTimeMs: number): void {
  // 型では塞いであるが、UI やプリセットから文字列で流れ込む経路があるので実行時にも見る。
  // ⚠️ `in` を使ってはいけない。プロトタイプチェーンを歩くので 'constructor' や 'toString' が
  // 素通りし、諸元が undefined のまま NaN が View まで流れる（例外より遥かに追いにくい壊れ方）。
  if (!Object.hasOwn(AURORA_INSTANCE_CLASSES, config.instanceClass)) {
    throw new RangeError(`未知のインスタンスクラス: ${config.instanceClass}`);
  }
  requirePositive(serviceTimeMs, 'serviceTimeMs');
  // retry の検証は `retryPolicy` setter が持つ（構築時もそこを通る）。
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} は正の有限数である必要がある: ${value}`);
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
