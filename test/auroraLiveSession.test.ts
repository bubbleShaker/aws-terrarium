import { describe, expect, it } from 'vitest';
import type { Demand } from '../src/core/sim/demand.js';
import {
  AuroraLiveSession,
  type AuroraLiveSettings,
} from '../src/core/scenario/aurora/liveSession.js';
import type { AuroraRetryPolicy } from '../src/core/services/aurora/writer.js';

const TICK_SECONDS = 0.1;

/** db.r6g.large + 5ms/クエリ = 総容量 400 q/s。M3 の看板の数字はこの構成で出る。 */
const baseSettings: AuroraLiveSettings = { instanceClass: 'db.r6g.large' };

const CAPACITY_PER_SEC = 400;
/** ρ=0.9。安全域。 */
const SAFE_RPS = 360;
/** ρ=2.0。スパイク。 */
const SPIKE_RPS = 800;

const retryPolicy: AuroraRetryPolicy = { clientTimeoutSeconds: 1, clientPopulation: 1_000 };

function load(writesPerSecond: number): Demand {
  return { readsPerSecond: 0, writesPerSecond };
}

function advanceSeconds(session: AuroraLiveSession, seconds: number, demand: Demand): void {
  const ticks = Math.round(seconds / TICK_SECONDS);
  for (let i = 0; i < ticks; i += 1) session.step(demand, TICK_SECONDS);
}

describe('AuroraLiveSession', () => {
  it('進める前でも壁の値は読める（View に分岐を持ち込まないため）', () => {
    const snapshot = new AuroraLiveSession(baseSettings).snapshot();

    // 静的な諸元は最初から入っている。
    expect(snapshot.maxVcpu).toBe(2);
    expect(snapshot.maxConnections).toBe(1_000);
    expect(snapshot.capacityPerSec).toBe(CAPACITY_PER_SEC);
    expect(snapshot.serviceTimeMs).toBeCloseTo(5, 10);
    expect(snapshot.retryEnabled).toBe(false);

    // 測定値はまだ 1 件も流れていないので 0。
    expect(snapshot.queueLength).toBe(0);
    expect(snapshot.latencyMs).toBe(0);
    expect(snapshot.activeSessions).toBe(0);
    expect(snapshot.simulatedSeconds).toBe(0);
  });

  it('snapshot は Performance Insights の読み方になっている（AAS ÷ Max vCPU）', () => {
    const session = new AuroraLiveSession(baseSettings);
    advanceSeconds(session, 30, load(SPIKE_RPS));
    const s = session.snapshot();

    // PI のあのグラフの読み方そのもの。1 を超えたら待ち行列ができている。
    expect(s.activeSessionsPerVcpu).toBeCloseTo(s.activeSessions / s.maxVcpu, 10);
    expect(s.activeSessionsPerVcpu).toBeGreaterThan(1);

    // Little の法則。L = λW が View まで壊れずに届いていることの確認。
    expect(s.activeSessions).toBeCloseTo(
      (s.servedRequestsPerSec * s.latencyMs) / 1_000,
      6,
    );

    // レイテンシは 2 項の和。過負荷では背圧項が主役だが、統計項も消えない。
    expect(s.waitMs).toBeCloseTo(s.backpressureMs + s.statisticalMs, 10);
    expect(s.latencyMs).toBeCloseTo(s.waitMs + s.serviceTimeMs, 10);
    expect(s.statisticalMs).toBeGreaterThan(0);
  });

  it('インスタンスクラスを上げると窓口は 2→16、待合室は 1,000→4,000 になる', () => {
    // 垂直スケールのダイヤル。上げても窓口が 8 倍にしかならない一方、
    // 待合室は 4 倍に「広がる」— 詰め込める人数ばかり増える構造がここに出ている。
    const session = new AuroraLiveSession(baseSettings);
    expect(session.snapshot().maxVcpu).toBe(2);
    expect(session.snapshot().maxConnections).toBe(1_000);

    session.update({ instanceClass: 'db.r6g.4xlarge' });

    expect(session.snapshot().maxVcpu).toBe(16);
    expect(session.snapshot().maxConnections).toBe(4_000);
    expect(session.snapshot().capacityPerSec).toBe(3_200);
  });

  it('インスタンスクラスを変えると待ち行列はリセットされる（スケールにはフェイルオーバーが伴う）', () => {
    // 実機の Aurora はスケールに数十秒の断を伴うので、溜まった接続は引き継がれない。
    // 教材としてはこちらが本題:「障害の最中にスケールして逃げ切ることはできない」。
    const session = new AuroraLiveSession(baseSettings);
    advanceSeconds(session, 30, load(SPIKE_RPS));
    expect(session.snapshot().queueLength).toBeGreaterThan(900);

    const rebuilt = session.update({ instanceClass: 'db.r6g.4xlarge' });

    expect(rebuilt).toBe(true);
    expect(session.snapshot().queueLength).toBe(0);
    expect(session.snapshot().generation).toBe(1);
    // 作り直したら仮想時間も 0 から（DynamoDbLiveSession と同じ扱い）。
    expect(session.snapshot().simulatedSeconds).toBe(0);
    expect(session.latest).toBeUndefined();
  });

  it('serviceTimeMs を変えても作り直される（容量が変わるため）', () => {
    // shape key のもう 1 つの構成要素。ここが鍵から落ちると
    // 「変えたのに容量が動かない」という危険側の壊れ方をするので、単独で固定しておく。
    const session = new AuroraLiveSession(baseSettings);
    advanceSeconds(session, 10, load(SAFE_RPS));

    const rebuilt = session.update({ serviceTimeMs: 10 });

    expect(rebuilt).toBe(true);
    expect(session.snapshot().generation).toBe(1);
    // 1 クエリ 10ms なら vCPU 2 本で 200 q/s。
    expect(session.snapshot().capacityPerSec).toBe(200);
  });

  it('serviceTimeMs の省略と既定値の明示は同じ writer を指す', () => {
    // 5ms は既定値。省略と明示で鍵が変わると、UI が値を書き戻しただけで
    // フェイルオーバー（＝待ち行列のリセット）が起きてしまう。
    const session = new AuroraLiveSession(baseSettings);

    expect(session.update({ serviceTimeMs: 5 })).toBe(false);
    expect(session.snapshot().generation).toBe(0);
  });

  it('同じ諸元を渡し直しても作り直さない', () => {
    const session = new AuroraLiveSession(baseSettings);
    advanceSeconds(session, 10, load(SAFE_RPS));
    const writer = session.writer;

    expect(session.replace({ instanceClass: 'db.r6g.large' })).toBe(false);
    expect(session.writer).toBe(writer);
    expect(session.snapshot().generation).toBe(0);
  });

  it('replace は省略可能なフィールドを残さない（再送 ON のプリセットが後を引かない）', () => {
    const session = new AuroraLiveSession({ ...baseSettings, retry: retryPolicy });

    session.replace(baseSettings);

    expect(session.settings.retry).toBeUndefined();
    expect(session.snapshot().retryEnabled).toBe(false);
    expect(session.writer.retryPolicy).toBeUndefined();
  });

  it('不正な再送ポリシーを渡しても設定と writer がズレない', () => {
    // setter が投げたあとに設定だけ新しくなると、
    // 「HUD は再送 ON と言っているが writer は再送していない」という二重の真実になる。
    const session = new AuroraLiveSession({ ...baseSettings, retry: retryPolicy });

    expect(() => session.update({ retry: { clientTimeoutSeconds: 0, clientPopulation: 10 } })).toThrow(
      RangeError,
    );

    expect(session.settings.retry).toBe(retryPolicy);
    expect(session.writer.retryPolicy).toBe(retryPolicy);
    expect(session.snapshot().retryEnabled).toBe(true);
  });

  it('再送を止めても待ち行列は消えない — が、そこから初めて回復が始まる', () => {
    // M3 の看板。「行列が伸びること」と「戻れなくなること」は別の現象である。
    //
    // ⚠️ ここでリセットしてしまうと、回復の理由が「増幅を断ち切ったから」ではなく
    // 「リセットしたから」に見えてしまう。だから再送の変更だけは writer を作り直さない。
    const session = new AuroraLiveSession({ ...baseSettings, retry: retryPolicy });

    advanceSeconds(session, 30, load(SAFE_RPS));
    expect(session.snapshot().queueLength).toBe(0);

    // 30 秒のスパイクで待合室が埋まる。
    advanceSeconds(session, 30, load(SPIKE_RPS));
    const spikeQueue = session.snapshot().queueLength;
    expect(spikeQueue).toBeGreaterThan(900);

    // トリガー（スパイク）を取り除いても戻らない。再送が劣化を自分で維持している。
    advanceSeconds(session, 60, load(SAFE_RPS));
    expect(session.snapshot().queueLength).toBeCloseTo(spikeQueue, 6);
    expect(session.snapshot().retriedRequestsPerSec).toBeGreaterThan(0);

    // 再送を切る。writer は作り直されないので、行列は 960 件並んだまま残っている。
    const rebuilt = session.update({ retry: undefined });
    expect(rebuilt).toBe(false);
    expect(session.snapshot().generation).toBe(0);
    expect(session.snapshot().queueLength).toBeCloseTo(spikeQueue, 6);

    // 増幅が消えて初めて、同じ負荷のまま行列が掃ける。
    advanceSeconds(session, 60, load(SAFE_RPS));
    expect(session.snapshot().queueLength).toBe(0);
    expect(session.snapshot().retriedRequestsPerSec).toBe(0);
    expect(session.snapshot().latencyMs).toBeLessThan(100);
  });

  it('再送が無ければスパイクからは自力で戻る', () => {
    // 上のテストとの差は再送だけ。「待ち行列は本来ちゃんと戻る」を対にして固定しておく。
    const session = new AuroraLiveSession(baseSettings);

    advanceSeconds(session, 30, load(SPIKE_RPS));
    expect(session.snapshot().queueLength).toBeGreaterThan(900);

    advanceSeconds(session, 30, load(SAFE_RPS));
    expect(session.snapshot().queueLength).toBe(0);
  });
});
