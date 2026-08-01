import type { JSX } from 'react';
import type { LaneKind } from '../../core/sim/demand.js';
import type { TerrariumSnapshot } from '../../core/scenario/driver.js';

interface ComparisonHudProps {
  readonly snapshot: TerrariumSnapshot;
  readonly lane: LaneKind;
}

const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('ja-JP', { style: 'percent', maximumFractionDigits: 0 });

/**
 * DynamoDB のレイテンシ (ms)。**このモデルは計算していない参考値である**。
 *
 * AWS が謳う「一桁ミリ秒」をそのまま置いている。
 * `DynamoDbTable` に時間軸は無く、待ち行列も持たないので、
 * ここで計算された数字を出すふりをすると教材が嘘をつくことになる。
 * 比を出すのに 1 つの値が要るので参考値として使い、画面でもそう表示する。
 *
 * ⚠️ Aurora の `AURORA_DEFAULT_SERVICE_TIME_MS` と値が同じ 5 なのは**偶然**で、
 * 両者に関係は無い。あちらは Aurora のサービス時間の仮定値、こちらは DynamoDB の参考値である。
 * 片方を動かしてももう片方を合わせる必要はない。
 */
const DYNAMODB_REFERENCE_LATENCY_MS = 5;

/** レイテンシ差がこの倍率を超えたら「桁が違う」と呼ぶ。 */
const ORDER_OF_MAGNITUDE = 10;
/** これを超えて遅ければ「もう体感できる遅さ」。 */
const NOTICEABLE_LATENCY_MS = 50;

/**
 * 並置の看板。**同じ負荷に対する 2 つの答えを、同じ行に並べる**。
 *
 * ## なぜこの 4 行なのか
 *
 * M3 の調査で分かった一番大事なことは
 * 「受理も拒否も完全に同じ数字を出しながら、レイテンシだけが 500 倍になる」だった。
 * これは**同じ指標を隣に並べたときにしか気づけない**。
 * CloudWatch でスループットとエラー率のグラフだけを見ていたら、この 2 つは見分けがつかない。
 *
 * 「受理」と「完了」を分けて出しているのは、Aurora だけがこの 2 つを乖離させられるためである。
 * 受理 420 / 完了 400 の差の 20 件/秒が、そのまま待合室に積み上がっている。
 * DynamoDB には待ち行列が無いので、この 2 行は常に同じ値になる — それ自体が対比になる。
 */
export function ComparisonHud({ snapshot, lane }: ComparisonHudProps): JSX.Element {
  const view = snapshot.dynamodb[lane];
  const aurora = snapshot.aurora;
  const total = snapshot.load.readsPerSecond + snapshot.load.writesPerSecond;

  const latencyRatio = aurora.latencyMs / DYNAMODB_REFERENCE_LATENCY_MS;
  // 「違いはレイテンシにしか出ていない」と言い切るには、**完了量と拒否量の両方**が
  // 一致している必要がある。
  //
  // ⚠️ 完了量だけで判定してはいけない。ρ=1.05 では DynamoDB が 20 q/s を拒否している一方で
  // Aurora の拒否は 0 なのに、完了量はどちらも 400 q/s で一致する。
  // そこだけを見ると「違いはレイテンシだけ」と表示されるが、
  // 拒否 20 対 0 は明らかにレイテンシ以外の違いであり、しかもそれがそのシナリオの主題そのものである。
  const matches = (a: number, b: number): boolean =>
    Math.abs(a - b) <= Math.max(a, b, 1) * 0.02;
  const numbersMatch =
    aurora.servedRequestsPerSec > 0 &&
    matches(view.acceptedRequestsPerSec, aurora.servedRequestsPerSec) &&
    matches(view.throttledRequestsPerSec, aurora.rejectedRequestsPerSec);
  const silentlySlow = aurora.rejectedRequestsPerSec === 0 && aurora.latencyMs > NOTICEABLE_LATENCY_MS;

  return (
    <section className="compare">
      <header className="compare__head">
        <span>
          同じ負荷 <b>{number.format(total)}</b> q/s を、1 本のダイヤルで両方へ
        </span>
        <span className="compare__clock">{snapshot.simulatedSeconds.toFixed(0)} 秒経過</span>
      </header>

      <table className="compare__table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">DynamoDB</th>
            <th scope="col">Aurora writer</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">受理</th>
            <td>{number.format(view.acceptedRequestsPerSec)} q/s</td>
            <td>{number.format(aurora.acceptedRequestsPerSec)} q/s</td>
          </tr>
          <tr>
            <th scope="row">拒否</th>
            <td>{number.format(view.throttledRequestsPerSec)} q/s</td>
            <td className={aurora.rejectedRequestsPerSec === 0 ? 'compare__quiet' : ''}>
              {number.format(aurora.rejectedRequestsPerSec)} q/s
            </td>
          </tr>
          <tr>
            <th scope="row">完了</th>
            <td>{number.format(view.acceptedRequestsPerSec)} q/s</td>
            <td>{number.format(aurora.servedRequestsPerSec)} q/s</td>
          </tr>
          <tr className="compare__row--latency">
            <th scope="row">レイテンシ</th>
            <td>
              一桁 ms<span className="compare__mark">※</span>
            </td>
            <td>
              <b>{number.format(aurora.latencyMs)} ms</b>
              {/* 分母が参考値なので、測定値に見える精度では出さない。 */}
              {latencyRatio >= ORDER_OF_MAGNITUDE && (
                <span className="compare__ratio">
                  {number.format(Math.floor(latencyRatio / 100) * 100)} 倍以上
                  <span className="compare__mark">※</span>
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {numbersMatch && latencyRatio >= ORDER_OF_MAGNITUDE && (
        <p className="compare__verdict">
          受理も拒否も完了も一致している。違いはレイテンシにしか出ていない。
          CloudWatch でスループットとエラー率だけを並べたら、この 2 つは見分けがつかない。
        </p>
      )}

      {silentlySlow && (
        <p className="compare__verdict compare__verdict--warn">
          Aurora はエラーを 1 件も出していない。それでもレイテンシは{' '}
          <b>{number.format(aurora.latencyMs)} ms</b> まで伸びている。
          待合室は {percent.format(Math.min(1, aurora.connectionUtilization))} 埋まっており、
          満席になるまで拒否は始まらない。エラー率だけを監視していると、この区間は完全に無風に見える。
        </p>
      )}

      <p className="note">
        ※ DynamoDB のレイテンシは<b>このモデルが計算していない</b>。時間軸の待ち行列を持たないため。
        AWS が謳う一桁ミリ秒を参考値 ({DYNAMODB_REFERENCE_LATENCY_MS} ms) として置いている。
      </p>
    </section>
  );
}
