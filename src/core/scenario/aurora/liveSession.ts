import type { Demand } from '../../sim/demand.js';
import {
  type AuroraInstanceClass,
  AURORA_DEFAULT_SERVICE_TIME_MS,
} from '../../services/aurora/instanceClasses.js';
import {
  AuroraWriter,
  type AuroraRetryPolicy,
  type AuroraWriterTickResult,
} from '../../services/aurora/writer.js';
import { stableStringify } from '../shapeKey.js';

/**
 * インタラクティブに動かすときの writer 設定。
 *
 * `DynamoDbLiveSettings` と対になるが、**共通のインターフェースへは押し込めない**。
 * あちらの設定はテーブルの形（パーティション数・キー分布・キャパシティ）であり、
 * こちらは 1 台のインスタンスの諸元である。共通化できるのは
 * 「渡す・進める・読む」という操作の形だけで、中身に共通項が無い。
 *
 * ⚠️ 負荷 (rps) はここにも無い。`TerrariumDriver` が 1 本だけ持つ（`DynamoDbLiveSettings` と同じ）。
 */
export interface AuroraLiveSettings {
  /** 垂直スケールのダイヤル。上げると窓口 (vCPU) と待合室 (max_connections) が両方増える。 */
  readonly instanceClass: AuroraInstanceClass;
  /**
   * 1 クエリの平均処理時間 (ms)。省略時 5ms。
   * ⚠️ このモデル唯一の仮定値（公式の値は存在しない）。
   */
  readonly serviceTimeMs?: number | undefined;
  /** 省略すると再送なし（＝ 自力で戻れるモデル）。 */
  readonly retry?: AuroraRetryPolicy | undefined;
}

/**
 * 起動時の設定。`db.r6g.large` は vCPU 2 / max_connections 1,000 で、
 * **並ぶ場所が捌ける本数の 500 倍広い**という M3 の主題がいちばん露骨に出るクラス。
 * 再送は既定で切ってある（まず「行列は自力で戻る」を見せてから、増幅を足して壊す）。
 */
export const defaultAuroraLiveSettings: AuroraLiveSettings = {
  instanceClass: 'db.r6g.large',
};

/**
 * View 向けに整形した Aurora の状態。
 *
 * ## 指標名は Performance Insights に合わせる（独自の名前を発明しない）
 *
 * | このモデルの内部 | ここでの名前 | Performance Insights |
 * |---|---|---|
 * | L（系内客数） | `activeSessions` | **AAS / DBLoad** |
 * | c（窓口数） | `maxVcpu` | **Max vCPU 線** |
 * | ρ = L/c | `activeSessionsPerVcpu` | AAS ÷ Max vCPU |
 *
 * 学習者が本物の Performance Insights を初めて開いたとき、
 * **画面の読み方をそのまま持ち込める**ことを狙っている。
 * ここで独自の指標名を作ると、覚えたことが AWS コンソールで通用しなくなる。
 */
export interface AuroraSessionSnapshot {
  /** この writer が生きている間に刻んだ仮想時間 (秒)。作り直すと 0 に戻る。 */
  readonly simulatedSeconds: number;
  /** writer を作り直した回数。View がリセットに追随するために使う。 */
  readonly generation: number;
  readonly instanceClass: AuroraInstanceClass;

  /** 壁A。Performance Insights の **Max vCPU 線**。 */
  readonly maxVcpu: number;
  /** 壁B。**待合室の広さ**であって性能の上限ではない。 */
  readonly maxConnections: number;
  /** 総容量 c × μ (件/秒)。過負荷でも増えも減りもしない。 */
  readonly capacityPerSec: number;
  readonly serviceTimeMs: number;
  readonly retryEnabled: boolean;

  /** 負荷ダイヤルが出している素の需要 (件/秒)。再送を含まない。 */
  readonly demandedRequestsPerSec: number;
  /** 再送で上乗せされた分 (件/秒)。増幅の大きさがそのまま見える。 */
  readonly retriedRequestsPerSec: number;
  readonly offeredRequestsPerSec: number;
  /** 待合室に入れた量 (件/秒)。 */
  readonly acceptedRequestsPerSec: number;
  /** 壁B であふれた量 (件/秒)。`Too many connections`。 */
  readonly rejectedRequestsPerSec: number;
  /** 完了した量 (件/秒)。過負荷では総容量に張り付く。 */
  readonly servedRequestsPerSec: number;

  /** 待ち行列長 Q。並んでいる人数そのもの。 */
  readonly queueLength: number;
  /** 待合室の占有率。**1 に達した瞬間から拒否が始まる**。 */
  readonly connectionUtilization: number;

  /** Performance Insights の **AAS / DBLoad**。 */
  readonly activeSessions: number;
  /** AAS ÷ Max vCPU。**1 を超えたら待ち行列ができている**。 */
  readonly activeSessionsPerVcpu: number;
  /** 提供負荷 ÷ 総容量。 */
  readonly offeredLoadRatio: number;

  /** クライアントから見たレイテンシ (ms)。DynamoDB との差はここにしか出ない。 */
  readonly latencyMs: number;
  readonly waitMs: number;
  /** 背圧項 (ms)。いま並んでいる列が掃ける時間。 */
  readonly backpressureMs: number;
  /** 統計項 (ms)。飽和以前のゆらぎ。ρ<1 でもレイテンシが伸びる理由。 */
  readonly statisticalMs: number;
}

/**
 * ダイヤルを回しながら動かし続ける Aurora writer のセッション。
 *
 * `DynamoDbLiveSession` と同じ役割 — 「作り直す / 作り直さない」の境界を 1 箇所に閉じ込め、
 * View には「設定を渡す」「最新の状態を読む」だけを見せる。
 *
 * ## インスタンスクラスを変えると待ち行列はリセットされる（意図的）
 *
 * 実機の Aurora はインスタンスのスケールに**フェイルオーバー（数十秒の断）を伴う**。
 * 溜まった接続がそのまま新しいインスタンスへ引き継がれることはないので、リセットが現実に忠実である。
 * そして教材としては、これがいちばん伝えたいことに直結する:
 *
 * > **障害の最中にスケールして逃げ切ることはできない。**
 *
 * 引き換えに「行列が掃けていく様子」はクラス変更では見られなくなるが、
 * それは**負荷ダイヤルを下げれば見られる**（そちらは作り直しを伴わない）ので失われていない。
 *
 * ## 一方、再送ポリシーの変更ではリセットしない（こちらも意図的）
 *
 * 再送を止めるのはクライアント側の設定変更であって、サーバの行列には何の影響も無い。
 * ここでリセットしてしまうと **メタステーブル障害の核心**
 * 「トリガーを取り除いても劣化が続く。増幅を断ち切って初めて戻る」が観測できなくなる。
 * そのため再送だけは writer を作り直さずに差し替える。
 */
export class AuroraLiveSession {
  #settings: AuroraLiveSettings;
  #writer: AuroraWriter;
  #shapeKey: string;
  #latest: AuroraWriterTickResult | undefined;
  #generation = 0;
  #simulatedSeconds = 0;

  constructor(settings: AuroraLiveSettings) {
    this.#settings = settings;
    this.#shapeKey = writerShapeKey(settings);
    this.#writer = buildWriter(settings);
  }

  get settings(): AuroraLiveSettings {
    return this.#settings;
  }

  get writer(): AuroraWriter {
    return this.#writer;
  }

  /** 直近の tick 結果。まだ 1 度も進んでいなければ undefined。 */
  get latest(): AuroraWriterTickResult | undefined {
    return this.#latest;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * 設定を差し替える。writer の形が変わる項目が含まれていれば作り直す。
   *
   * @returns 作り直したかどうか（＝待ち行列がリセットされたかどうか）
   */
  update(patch: Partial<AuroraLiveSettings>): boolean {
    return this.#apply({ ...this.#settings, ...patch });
  }

  /**
   * 設定を**まるごと**差し替える。プリセットの読み込み用。
   *
   * `update()` に委譲してはいけない（`DynamoDbLiveSession` と同じ理由）。
   * あちらはマージなので、省略可能なフィールド (`retry` / `serviceTimeMs`) が
   * 前の設定から残留する。「再送 ON のプリセットを見たあとは、
   * どのプリセットを選んでも再送が入ったまま」という形で教材が壊れる。
   */
  replace(settings: AuroraLiveSettings): boolean {
    return this.#apply(settings);
  }

  #apply(next: AuroraLiveSettings): boolean {
    const nextShapeKey = writerShapeKey(next);
    if (nextShapeKey === this.#shapeKey) {
      // 諸元は同じ。違いがあるとすれば再送ポリシーだけなので、行列を保ったまま差し替える。
      //
      // ⚠️ setter が先。これが不正値で例外を投げたとき、順序が逆だと
      // 「設定は新しいのに writer は古い」状態で固定される（作り直し側と同じ罠）。
      this.#writer.retryPolicy = next.retry;
      this.#settings = next;
      return false;
    }

    // 先に作ってから差し替える。設定が不正で例外が飛んだとき、
    // 「鍵は新しいのに writer は古い」状態で固定されると二度と再構築されなくなる
    // （`DynamoDbLiveSession` と同じ手当て）。
    const writer = buildWriter(next);

    this.#settings = next;
    this.#shapeKey = nextShapeKey;
    this.#writer = writer;
    this.#latest = undefined;
    this.#generation += 1;
    this.#simulatedSeconds = 0;
    return true;
  }

  /**
   * 1 tick 進める。**呼ぶのは `TerrariumDriver` だけ**。
   *
   * 受け取る `demand` は DynamoDB 側へ渡すものと**同一の値**である。
   * これが M3 の全体の前提（同じ負荷を両方へ流す）を構造として担保している。
   */
  step(demand: Demand, tickSeconds: number): void {
    this.#latest = this.#writer.step(demand, tickSeconds);
    this.#simulatedSeconds += tickSeconds;
  }

  /**
   * View 向けの読みやすい形に変換した現在の状態。
   *
   * 毎フレームではなく HUD の更新頻度 (10Hz 程度) で呼ぶ想定
   * （毎フレーム必要な値は `latest` から直接読む）。
   */
  snapshot(): AuroraSessionSnapshot {
    const writer = this.#writer;
    const latest = this.#latest;
    return {
      simulatedSeconds: this.#simulatedSeconds,
      generation: this.#generation,
      instanceClass: this.#settings.instanceClass,

      maxVcpu: writer.maxVcpu,
      maxConnections: writer.maxConnections,
      capacityPerSec: writer.capacityPerSec,
      serviceTimeMs: writer.serviceTimeSeconds * 1_000,
      // 設定ではなく writer に効いている値から導出する。
      // 設定側を見ると「HUD は再送 ON と言っているが writer は再送していない」がありえる。
      retryEnabled: writer.retryPolicy !== undefined,

      // まだ 1 度も進んでいなければ 0 で埋める。View から分岐を追い出すため
      // （`DynamoDbLiveSession` が柱を 0 で埋めているのと同じ方針）。
      demandedRequestsPerSec: latest?.demandedRequestsPerSec ?? 0,
      retriedRequestsPerSec: latest?.retriedRequestsPerSec ?? 0,
      offeredRequestsPerSec: latest?.offeredRequestsPerSec ?? 0,
      acceptedRequestsPerSec: latest?.acceptedRequestsPerSec ?? 0,
      rejectedRequestsPerSec: latest?.rejectedRequestsPerSec ?? 0,
      servedRequestsPerSec: latest?.servedRequestsPerSec ?? 0,

      queueLength: writer.queueLength,
      connectionUtilization: latest?.connectionUtilization ?? 0,

      activeSessions: latest?.activeSessions ?? 0,
      activeSessionsPerVcpu: latest?.activeSessionsPerVcpu ?? 0,
      offeredLoadRatio: latest?.offeredLoadRatio ?? 0,

      latencyMs: toMs(latest?.latencySeconds),
      waitMs: toMs(latest?.waitSeconds),
      backpressureMs: toMs(latest?.backpressureSeconds),
      statisticalMs: toMs(latest?.statisticalSeconds),
    };
  }
}

function buildWriter(settings: AuroraLiveSettings): AuroraWriter {
  return new AuroraWriter({
    instanceClass: settings.instanceClass,
    serviceTimeMs: settings.serviceTimeMs,
    retry: settings.retry,
  });
}

/**
 * writer の「形」を表す文字列。これが変わったら作り直す＝待ち行列がリセットされる。
 *
 * **除外するのは再送ポリシーだけ**（理由はクラスの解説を参照）で、残りは丸ごと鍵にする。
 * 諸元を列挙して書くと、設定項目を足したときに追加を忘れて
 * 「クラスを変えたのに壁が動かない」という危険側の壊れ方をする。
 * 除外を明示する形にしておけば、忘れたときは「余計に作り直す」（安全側）に倒れる。
 */
function writerShapeKey(settings: AuroraLiveSettings): string {
  const { retry: _retry, ...shape } = settings;
  // 既定値を補ってから鍵にする。省略と明示の 5 は同じ writer を意味するので、
  // 素の undefined のままだと「5ms を明示しただけ」でフェイルオーバーが起きる。
  return stableStringify({
    ...shape,
    serviceTimeMs: shape.serviceTimeMs ?? AURORA_DEFAULT_SERVICE_TIME_MS,
  });
}

function toMs(seconds: number | undefined): number {
  return (seconds ?? 0) * 1_000;
}
