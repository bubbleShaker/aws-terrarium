import type { JSX } from 'react';
import type { LaneKind, SessionSnapshot } from '../../core/scenario/liveSession.js';

interface StatusHudProps {
  readonly snapshot: SessionSnapshot;
  readonly lane: LaneKind;
  readonly lesson: string;
  readonly presetName: string;
}

const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('ja-JP', { style: 'percent', maximumFractionDigits: 1 });

/**
 * 数字の側の説明。
 *
 * ここで一番見せたいのは「テーブル全体のスロットル率」と
 * 「最も熱い 1 本のスロットル率」の**差**である。
 * 集計値がホットパーティションを隠す、という M1 の発見をそのまま画面に出す
 * （CloudWatch の集計値だけ見ていて障害に気づけない事故の正体）。
 */
export function StatusHud({ snapshot, lane, lesson, presetName }: StatusHudProps): JSX.Element {
  const view = snapshot[lane];
  const hottest = view.hottest;
  const hidden =
    hottest !== undefined && hottest.throttleRate - view.throttleRate > 0.05;

  return (
    <aside className="panel panel--status">
      <h2 className="panel__title">
        DynamoDB <span className="panel__sub">{presetName}</span>
      </h2>
      <p className="lesson">{lesson}</p>

      <dl className="stats">
        <div className="stat">
          <dt>経過（仮想）</dt>
          <dd>{snapshot.simulatedSeconds.toFixed(1)} 秒</dd>
        </div>
        <div className="stat">
          <dt>パーティション</dt>
          <dd>{snapshot.partitionCount} 本</dd>
        </div>
        <div className="stat">
          <dt>アダプティブ</dt>
          <dd>{snapshot.adaptiveCapacity ? 'ON' : 'OFF'}</dd>
        </div>
        <div className="stat">
          <dt>1 本の上限</dt>
          <dd>{number.format(view.info.hardCapUnitsPerSec)} units/s</dd>
        </div>
        <div className="stat">
          <dt>頭割りの取り分</dt>
          <dd>{number.format(view.info.baselineUnitsPerSec)} units/s</dd>
        </div>
        <div className="stat">
          <dt>受理</dt>
          <dd>{number.format(view.acceptedRequestsPerSec)} req/s</dd>
        </div>
      </dl>

      <div className="gauge">
        <div className="gauge__head">
          <span>テーブル全体のスロットル率</span>
          <b>{percent.format(view.throttleRate)}</b>
        </div>
        <div className="bar">
          <div className="bar__fill bar__fill--table" style={{ width: `${Math.min(100, view.throttleRate * 100)}%` }} />
        </div>
      </div>

      {hottest !== undefined && (
        <div className="gauge">
          <div className="gauge__head">
            <span>最も熱い柱 #{hottest.index} のスロットル率</span>
            <b>{percent.format(hottest.throttleRate)}</b>
          </div>
          <div className="bar">
            <div className="bar__fill bar__fill--hot" style={{ width: `${Math.min(100, hottest.throttleRate * 100)}%` }} />
          </div>
          <ul className="detail">
            <li>
              需要 <b>{number.format(hottest.demandedUnitsPerSec)}</b> units/s（物理上限の{' '}
              <b>{hottest.utilizationVsHardCap.toFixed(1)} 倍</b>）
            </li>
            <li>
              トラフィックの <b>{percent.format(hottest.weight)}</b> がこの 1 本に集まっている
              （均等なら {percent.format(snapshot.idealShare)}）
            </li>
            <li>
              バーストの残り <b>{percent.format(hottest.burstRatio)}</b>
              {hottest.burstDrawUnitsPerSec > 0 && (
                <>
                  {' '}
                  — いま <b>{number.format(hottest.burstDrawUnitsPerSec)}</b> units/s を貯金から持ち出し中
                </>
              )}
            </li>
          </ul>
        </div>
      )}

      {hidden && (
        <p className="warning">
          集計値がホットパーティションを隠している。全体では{' '}
          {percent.format(view.throttleRate)} にしか見えないが、
          このキーを使っているユーザーからは {percent.format(hottest?.throttleRate ?? 0)} が失敗している。
        </p>
      )}

      <ul className="legend">
        <li>
          <span className="swatch swatch--demand" />
          外側の半透明 = 需要（色は需要 ÷ 物理上限）
        </li>
        <li>
          <span className="swatch swatch--accepted" />
          内側の実体 = 通った量。黄色いほど頭打ち
        </li>
        <li>
          <span className="swatch swatch--burst" />
          台座 = バーストの貯金。暗いほど残り少ない
        </li>
        <li>
          <span className="swatch swatch--cap" />
          赤い面 = 1 パーティションの物理上限。突き抜けたら打つ手なし
        </li>
      </ul>
    </aside>
  );
}
