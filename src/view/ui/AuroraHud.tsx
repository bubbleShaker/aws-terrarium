import type { JSX } from 'react';
import type { Demand } from '../../core/sim/demand.js';
import type { AuroraSessionSnapshot } from '../../core/scenario/aurora/liveSession.js';
import { REQUESTS_PER_SEAT } from '../layout.js';

interface AuroraHudProps {
  readonly snapshot: AuroraSessionSnapshot;
  /** 共有の負荷ダイヤルの現在値。writer が両レーンを合算して受けることを示すのに使う。 */
  readonly load: Demand;
}

const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('ja-JP', { style: 'percent', maximumFractionDigits: 0 });

/**
 * Aurora writer の数字。
 *
 * ## 指標名は Performance Insights のまま使う
 *
 * `AuroraSessionSnapshot` が既に `activeSessions` (AAS) / `maxVcpu` (Max vCPU 線) という
 * 名前で値を持っている。ここで「待ち行列長」「窓口数」と言い換えない。
 *
 * 学習者が本物の Performance Insights を初めて開いたとき、
 * **画面の読み方をそのまま持ち込める**ことを狙っているので、
 * 独自の指標名を発明した時点でこの HUD の存在意義が消える。
 * AAS が Max vCPU 線を超えたら待ち行列ができている、というあの読み方が
 * そのままこの画面の読み方になる。
 */
export function AuroraHud({ snapshot, load }: AuroraHudProps): JSX.Element {
  const overVcpu = snapshot.activeSessionsPerVcpu > 1;
  // 「エラーが出るまでの猶予」は Core が出す（教材上の主張を担う数字なので、
  // ここで組み立てると View にロジックが漏れる）。
  const secondsUntilFull = snapshot.secondsUntilConnectionsFull;

  return (
    <aside className="panel">
      <h2 className="panel__title">
        Aurora writer <span className="panel__sub">{snapshot.instanceClass}</span>
      </h2>

      <dl className="stats">
        <div className="stat">
          <dt>Max vCPU（壁A）</dt>
          <dd>{snapshot.maxVcpu} 本</dd>
        </div>
        <div className="stat">
          <dt>max_connections（壁B）</dt>
          <dd>{number.format(snapshot.maxConnections)}</dd>
        </div>
        <div className="stat">
          <dt>総容量 c × μ</dt>
          <dd>{number.format(snapshot.capacityPerSec)} q/s</dd>
        </div>
        <div className="stat">
          <dt>再送（増幅）</dt>
          <dd>{snapshot.retryEnabled ? 'ON' : 'OFF'}</dd>
        </div>
      </dl>

      {/*
        Performance Insights のあのグラフ。AAS が Max vCPU 線を超えたら待ち行列ができている。
        目盛りは Max vCPU 線が中央に来るよう取ってあるので、線の位置は常に 50% にある。
      */}
      <div className="gauge">
        <div className="gauge__head">
          <span>AAS（DBLoad）÷ Max vCPU</span>
          <b>{decimal.format(snapshot.activeSessions)}</b>
        </div>
        <div className="bar bar--vcpu">
          <div
            className={`bar__fill ${overVcpu ? 'bar__fill--hot' : 'bar__fill--ok'}`}
            style={{ width: `${Math.min(100, (snapshot.activeSessionsPerVcpu / 2) * 100)}%` }}
          />
          <span className="bar__mark" />
        </div>
        <ul className="detail">
          <li>
            AAS <b>{decimal.format(snapshot.activeSessions)}</b> ÷ Max vCPU{' '}
            <b>{snapshot.maxVcpu}</b> = <b>{decimal.format(snapshot.activeSessionsPerVcpu)}</b>
            {overVcpu ? ' — 1 を超えている。待ち行列ができている' : ' — 窓口で捌けている'}
          </li>
        </ul>
      </div>

      <div className="gauge">
        <div className="gauge__head">
          <span>待合室の占有（壁B）</span>
          <b>{percent.format(Math.min(1, snapshot.connectionUtilization))}</b>
        </div>
        <div className="bar">
          <div
            className="bar__fill bar__fill--seat"
            style={{ width: `${Math.min(100, snapshot.connectionUtilization * 100)}%` }}
          />
        </div>
        <ul className="detail">
          <li>
            並んでいる <b>{number.format(snapshot.queueLength)}</b> 件 /{' '}
            {number.format(snapshot.maxConnections)} 席（空間では 1 席 = {REQUESTS_PER_SEAT} 件）
          </li>
          {secondsUntilFull !== undefined && (
            <li>
              満席まで <b>{number.format(secondsUntilFull)}</b> 秒。
              そこまで拒否は 1 件も出ない
            </li>
          )}
        </ul>
      </div>

      <div className="gauge">
        <div className="gauge__head">
          <span>レイテンシの内訳</span>
          <b>{number.format(snapshot.latencyMs)} ms</b>
        </div>
        <ul className="detail">
          <li>
            背圧項 <b>{number.format(snapshot.backpressureMs)}</b> ms — いま並んでいる列が掃ける時間
          </li>
          <li>
            統計項 <b>{decimal.format(snapshot.statisticalMs)}</b> ms — Erlang C。
            <b>飽和する前から遅くなる</b>のはこの項のせい
          </li>
          <li>
            処理 <b>{decimal.format(snapshot.serviceTimeMs)}</b> ms
            <span className="compare__mark"> ※このモデル唯一の仮定値</span>
          </li>
        </ul>
      </div>

      <p className="note">
        writer は read/write を合算して受ける（reader を置いていない単一構成のため）。
        いま流れているのは read {number.format(load.readsPerSecond)} + write{' '}
        {number.format(load.writesPerSecond)} = <b>{number.format(snapshot.demandedRequestsPerSec)}</b> q/s。
        左のレーン切り替えは DynamoDB 側の表示だけを変える。
      </p>

      <ul className="legend">
        <li>
          <span className="swatch swatch--seat" />
          席 = 待合室の 1 席（{REQUESTS_PER_SEAT} 件）。点いている数が並んでいる人数
        </li>
        <li>
          <span className="swatch swatch--gate" />
          writer 前面の窓口 = vCPU。<b>過負荷でも本数は増えない</b>
        </li>
        <li>
          <span className="swatch swatch--wait" />
          待合室の床 = レイテンシ。粒子が床を渡りきる時間がそのまま待ち時間
        </li>
      </ul>
    </aside>
  );
}
