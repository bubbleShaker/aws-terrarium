import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { Demand, LaneKind } from '../../core/sim/demand.js';
import type { DynamoDbLiveSettings } from '../../core/scenario/dynamodb/liveSession.js';
import { type DynamoDbLivePreset, dynamoDbLivePresets } from '../../core/scenario/dynamodb/livePresets.js';
import type { KeyDistributionSpec } from '../../core/services/dynamodb/keyDistribution.js';

interface ControlPanelProps {
  readonly settings: DynamoDbLiveSettings;
  /** 共有の負荷ダイヤル。テーブル設定とは別物なので prop も分けている。 */
  readonly load: Demand;
  readonly lane: LaneKind;
  readonly presetName: string;
  readonly timeScale: number;
  readonly onChange: (patch: Partial<DynamoDbLiveSettings>) => void;
  readonly onLoadChange: (patch: Partial<Demand>) => void;
  readonly onLoadPreset: (preset: DynamoDbLivePreset) => void;
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

/** 分布を切り替えたときに使う既定値。切り替えのたびに極端な値へ飛ばないため。 */
const DEFAULT_SKEW = 0.7;
const DEFAULT_HOT_RATIO = 0.9;

const number = new Intl.NumberFormat('ja-JP');

interface ChipProps {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly danger?: boolean;
  readonly children: ReactNode;
}

function Chip({ on, onClick, danger = false, children }: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`chip ${danger ? 'chip--danger' : ''} ${on ? 'chip--on' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface StructuralRangeProps {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly onCommit: (value: number) => void;
}

/**
 * テーブルを作り直す設定のスライダー。
 *
 * 掴んでいる間は**確定させない**。`onChange` のたびに反映すると、
 * 1 回のドラッグで数十回テーブルが作り直され、そのたびに仮想時間とバーストが 0 に戻る。
 * つまりドラッグ中は一度も時間が進まず、何も観測できない。
 */
function StructuralRange({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: StructuralRangeProps): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };

  return (
    <label className="control__sub" htmlFor={id}>
      {label} <b>{format(shown)}</b> ⟳
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onPointerCancel={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  );
}

/**
 * ダイヤル一式。
 *
 * `⟳` を付けた項目は、変更するとテーブルを作り直す = シミュレーションがリセットされる。
 * これは実機の挙動ではなく本モデルの都合（`DynamoDbTable` は設定不変）だが、
 * 黙って時刻とバーストが戻ると「なぜ急に直ったのか」が分からなくなるので明示する。
 *
 * 表示値はすべて `settings` から導出する。ローカルに控えを持つと、
 * プリセットを読み込んだときに画面と実体がずれる。
 */
export function ControlPanel({
  settings,
  load,
  lane,
  presetName,
  timeScale,
  onChange,
  onLoadChange,
  onLoadPreset,
  onLaneChange,
  onTimeScaleChange,
}: ControlPanelProps): JSX.Element {
  const isWrite = lane === 'write';
  const loadValue = isWrite ? load.writesPerSecond : load.readsPerSecond;
  const provisioned = settings.capacity.mode === 'provisioned';
  const capacityValue = provisioned
    ? isWrite
      ? settings.capacity.writeCapacityUnits
      : settings.capacity.readCapacityUnits
    : 0;

  const distribution = settings.distribution;
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
          {dynamoDbLivePresets.map((preset) => (
            <Chip
              key={preset.name}
              on={preset.name === presetName}
              onClick={() => onLoadPreset(preset)}
            >
              {preset.name}
            </Chip>
          ))}
        </div>
      </section>

      <section className="control">
        <span className="control__label">見るレーン</span>
        <div className="chips">
          {(['write', 'read'] as const).map((kind) => (
            <Chip key={kind} on={kind === lane} onClick={() => onLaneChange(kind)}>
              {kind === 'write' ? '書き込み' : '読み取り'}
            </Chip>
          ))}
        </div>
      </section>

      <section className="control">
        <label className="control__label" htmlFor="load">
          負荷 <b>{number.format(Math.round(loadValue))}</b> req/s
        </label>
        {/* 負荷はテーブルを作り直さないので、動かした端から反映してよい。 */}
        <input
          id="load"
          type="range"
          min={0}
          max={isWrite ? 60_000 : 6_000}
          step={isWrite ? 500 : 50}
          value={loadValue}
          onChange={(event) => {
            const value = Number(event.target.value);
            onLoadChange(isWrite ? { writesPerSecond: value } : { readsPerSecond: value });
          }}
        />
        <p className="note">
          このダイヤルは 1 本しかない。DynamoDB と Aurora へ同じ量が流れる。
          片方だけずらす切り替えは意図的に用意していない（実験が公平でなくなるため）。
        </p>
      </section>

      <section className="control">
        <span className="control__label">キー分布 ⟳</span>
        <div className="chips">
          <Chip
            on={distribution.kind === 'uniform'}
            onClick={() => {
              if (distribution.kind !== 'uniform') setDistribution({ kind: 'uniform' });
            }}
          >
            uniform
          </Chip>
          <Chip
            on={distribution.kind === 'zipf'}
            onClick={() => {
              if (distribution.kind !== 'zipf') setDistribution({ kind: 'zipf', skew: DEFAULT_SKEW });
            }}
          >
            zipf
          </Chip>
          <Chip
            danger
            on={distribution.kind === 'singleHot'}
            onClick={() => {
              if (distribution.kind !== 'singleHot') {
                setDistribution({ kind: 'singleHot', hotRatio: DEFAULT_HOT_RATIO });
              }
            }}
          >
            singleHot
          </Chip>
        </div>

        {distribution.kind === 'zipf' && (
          <StructuralRange
            id="skew"
            label="偏り skew"
            value={distribution.skew}
            min={0}
            max={1.6}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onCommit={(skew) => setDistribution({ kind: 'zipf', skew })}
          />
        )}

        {distribution.kind === 'singleHot' && (
          <StructuralRange
            id="hot-ratio"
            label="1 キーへの集中"
            value={distribution.hotRatio}
            min={0.1}
            max={1}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onCommit={(hotRatio) => setDistribution({ kind: 'singleHot', hotRatio })}
          />
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
          <StructuralRange
            id="capacity"
            label={`プロビジョニング ${isWrite ? 'WCU' : 'RCU'}`}
            value={capacityValue}
            min={1_000}
            max={40_000}
            step={1_000}
            format={(value) => number.format(value)}
            onCommit={setCapacity}
          />
        </section>
      )}

      <section className="control">
        <span className="control__label">項目サイズ ⟳</span>
        <div className="chips">
          {ITEM_SIZES.map((size) => (
            <Chip
              key={size}
              on={settings.itemSizeKb === size}
              onClick={() => {
                if (settings.itemSizeKb !== size) onChange({ itemSizeKb: size });
              }}
            >
              {size}KB
            </Chip>
          ))}
        </div>
      </section>

      <section className="control">
        <span className="control__label">時間</span>
        <div className="chips">
          {TIME_SCALES.map((scale) => (
            <Chip
              key={scale.value}
              on={scale.value === timeScale}
              onClick={() => onTimeScaleChange(scale.value)}
            >
              {scale.label}
            </Chip>
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
