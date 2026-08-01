import { useState } from 'react';
import type { JSX } from 'react';
import type { LaneKind, LiveSettings } from '../../core/scenario/liveSession.js';
import { type LivePreset, livePresets } from '../../core/scenario/livePresets.js';
import type { KeyDistributionSpec } from '../../core/services/dynamodb/keyDistribution.js';

interface ControlPanelProps {
  readonly settings: LiveSettings;
  readonly lane: LaneKind;
  readonly presetName: string;
  readonly timeScale: number;
  readonly onChange: (patch: Partial<LiveSettings>) => void;
  readonly onLoadPreset: (preset: LivePreset) => void;
  readonly onLaneChange: (lane: LaneKind) => void;
  readonly onTimeScaleChange: (scale: number) => void;
}

const ITEM_SIZES = [1, 4, 8, 20] as const;
const TIME_SCALES = [
  { value: 0, label: '⏸ 停止' },
  { value: 1, label: '▶ 等速' },
  { value: 4, label: '⏩ 4倍' },
  { value: 20, label: '⏩⏩ 20倍' },
  { value: 60, label: '⏩⏩⏩ 60倍' },
] as const;

const number = new Intl.NumberFormat('ja-JP');

/**
 * ダイヤル一式。
 *
 * `⟳` を付けた項目は、変更するとテーブルを作り直す = シミュレーションがリセットされる。
 * これは実機の挙動ではなく本モデルの都合（`DynamoDbTable` は設定不変）だが、
 * 黙って時刻とバーストが戻ると「なぜ急に直ったのか」が分からなくなるので明示する。
 */
export function ControlPanel({
  settings,
  lane,
  presetName,
  timeScale,
  onChange,
  onLoadPreset,
  onLaneChange,
  onTimeScaleChange,
}: ControlPanelProps): JSX.Element {
  // 分布の種類を行き来しても値が飛ばないよう、直近のパラメータを覚えておく。
  const [skew, setSkew] = useState(0.7);
  const [hotRatio, setHotRatio] = useState(0.9);

  const isWrite = lane === 'write';
  const loadValue = isWrite ? settings.writesPerSecond : settings.readsPerSecond;
  const provisioned = settings.capacity.mode === 'provisioned';
  const capacityValue = provisioned
    ? isWrite
      ? settings.capacity.writeCapacityUnits
      : settings.capacity.readCapacityUnits
    : 0;

  const setDistribution = (spec: KeyDistributionSpec): void => onChange({ distribution: spec });

  const setCapacity = (value: number): void => {
    if (settings.capacity.mode !== 'provisioned') return;
    onChange({
      capacity: isWrite
        ? { ...settings.capacity, writeCapacityUnits: value }
        : { ...settings.capacity, readCapacityUnits: value },
    });
  };

  return (
    <aside className="panel panel--controls">
      <h2 className="panel__title">コントロール</h2>

      <section className="control">
        <span className="control__label">プリセット（M1 のシナリオ）</span>
        <div className="chips">
          {livePresets.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className={`chip ${preset.name === presetName ? 'chip--on' : ''}`}
              onClick={() => onLoadPreset(preset)}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </section>

      <section className="control">
        <span className="control__label">見るレーン</span>
        <div className="chips">
          {(['write', 'read'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`chip ${kind === lane ? 'chip--on' : ''}`}
              onClick={() => onLaneChange(kind)}
            >
              {kind === 'write' ? '書き込み' : '読み取り'}
            </button>
          ))}
        </div>
      </section>

      <section className="control">
        <label className="control__label" htmlFor="load">
          負荷 <b>{number.format(Math.round(loadValue))}</b> req/s
        </label>
        <input
          id="load"
          type="range"
          min={0}
          max={isWrite ? 60_000 : 6_000}
          step={isWrite ? 500 : 50}
          value={loadValue}
          onChange={(event) => {
            const value = Number(event.target.value);
            onChange(isWrite ? { writesPerSecond: value } : { readsPerSecond: value });
          }}
        />
      </section>

      <section className="control">
        <span className="control__label">キー分布 ⟳</span>
        <div className="chips">
          <button
            type="button"
            className={`chip ${settings.distribution.kind === 'uniform' ? 'chip--on' : ''}`}
            onClick={() => setDistribution({ kind: 'uniform' })}
          >
            uniform
          </button>
          <button
            type="button"
            className={`chip ${settings.distribution.kind === 'zipf' ? 'chip--on' : ''}`}
            onClick={() => setDistribution({ kind: 'zipf', skew })}
          >
            zipf
          </button>
          <button
            type="button"
            className={`chip chip--danger ${settings.distribution.kind === 'singleHot' ? 'chip--on' : ''}`}
            onClick={() => setDistribution({ kind: 'singleHot', hotRatio })}
          >
            singleHot
          </button>
        </div>

        {settings.distribution.kind === 'zipf' && (
          <label className="control__sub">
            偏り skew <b>{skew.toFixed(2)}</b>
            <input
              type="range"
              min={0}
              max={1.6}
              step={0.05}
              value={skew}
              onChange={(event) => {
                const value = Number(event.target.value);
                setSkew(value);
                setDistribution({ kind: 'zipf', skew: value });
              }}
            />
          </label>
        )}

        {settings.distribution.kind === 'singleHot' && (
          <label className="control__sub">
            1 キーへの集中 <b>{Math.round(hotRatio * 100)}%</b>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={hotRatio}
              onChange={(event) => {
                const value = Number(event.target.value);
                setHotRatio(value);
                setDistribution({ kind: 'singleHot', hotRatio: value });
              }}
            />
          </label>
        )}
      </section>

      <section className="control">
        <label className="control__row">
          <input
            type="checkbox"
            checked={provisioned ? settings.capacity.adaptiveCapacity : true}
            disabled={!provisioned}
            onChange={(event) => {
              if (settings.capacity.mode !== 'provisioned') return;
              onChange({
                capacity: { ...settings.capacity, adaptiveCapacity: event.target.checked },
              });
            }}
          />
          <span>アダプティブキャパシティ ⟳</span>
        </label>
        {!provisioned && (
          <p className="note">on-demand では常に有効。切れるスイッチとして持たせていない。</p>
        )}
      </section>

      {provisioned && (
        <section className="control">
          <label className="control__label" htmlFor="capacity">
            プロビジョニング {isWrite ? 'WCU' : 'RCU'} <b>{number.format(capacityValue)}</b> ⟳
          </label>
          <input
            id="capacity"
            type="range"
            min={1_000}
            max={40_000}
            step={1_000}
            value={capacityValue}
            onChange={(event) => setCapacity(Number(event.target.value))}
          />
        </section>
      )}

      <section className="control">
        <span className="control__label">項目サイズ ⟳</span>
        <div className="chips">
          {ITEM_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={`chip ${settings.itemSizeKb === size ? 'chip--on' : ''}`}
              onClick={() => onChange({ itemSizeKb: size })}
            >
              {size}KB
            </button>
          ))}
        </div>
      </section>

      <section className="control">
        <span className="control__label">時間</span>
        <div className="chips">
          {TIME_SCALES.map((scale) => (
            <button
              key={scale.value}
              type="button"
              className={`chip ${scale.value === timeScale ? 'chip--on' : ''}`}
              onClick={() => onTimeScaleChange(scale.value)}
            >
              {scale.label}
            </button>
          ))}
        </div>
        <p className="note">
          倍速にしてもシミュレーションの刻み幅は変わらない。バーストの貯金が尽きるまで
          数百秒かかるので、早送りで先を見る。
        </p>
      </section>

      <p className="note note--footer">
        ⟳ の項目はテーブルを作り直す（＝経過時間とバーストの貯金がリセットされる）。
        パーティション数もキーの割り当ても構築時に決まるため。
      </p>
    </aside>
  );
}
