import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { Demand, LaneKind } from '../../core/sim/demand.js';
import type { AuroraLiveSettings } from '../../core/scenario/aurora/liveSession.js';
import type { DynamoDbLiveSettings } from '../../core/scenario/dynamodb/liveSession.js';
import { type TerrariumPreset, terrariumPresets } from '../../core/scenario/terrariumPresets.js';
import {
  AURORA_INSTANCE_CLASSES,
  AURORA_INSTANCE_CLASS_NAMES,
} from '../../core/services/aurora/instanceClasses.js';
import type { KeyDistributionSpec } from '../../core/services/dynamodb/keyDistribution.js';
import { dialToRequestsPerSec, loadDialMaxPosition, requestsPerSecToDial } from '../loadDial.js';

interface ControlPanelProps {
  readonly settings: DynamoDbLiveSettings;
  readonly aurora: AuroraLiveSettings;
  /** 共有の負荷ダイヤル。テーブル設定とは別物なので prop も分けている。 */
  readonly load: Demand;
  readonly lane: LaneKind;
  readonly presetName: string;
  readonly timeScale: number;
  readonly onChange: (patch: Partial<DynamoDbLiveSettings>) => void;
  readonly onAuroraChange: (patch: Partial<AuroraLiveSettings>) => void;
  readonly onLoadChange: (patch: Partial<Demand>) => void;
  readonly onLoadPreset: (preset: TerrariumPreset) => void;
  readonly onLaneChange: (lane: LaneKind) => void;
  readonly onTimeScaleChange: (scale: number) => void;
}

/**
 * 既定の再送ポリシー。**メタステーブル障害の増幅そのもの**。
 *
 * 1 秒で諦めて再送するクライアントが最大 2,000。母集団を有限に閉じているのは、
 * 「行列長に比例」と書くと発散するため（`AuroraRetryPolicy` の解説を参照）。
 */
const DEFAULT_RETRY = { clientTimeoutSeconds: 1, clientPopulation: 2_000 } as const;

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
  aurora,
  load,
  lane,
  presetName,
  timeScale,
  onChange,
  onAuroraChange,
  onLoadChange,
  onLoadPreset,
  onLaneChange,
  onTimeScaleChange,
}: ControlPanelProps): JSX.Element {
  const isWrite = lane === 'write';
  const loadValue = isWrite ? load.writesPerSecond : load.readsPerSecond;
  const loadMax = isWrite ? 60_000 : 6_000;
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
    <aside className="panel">
      <h2 className="panel__title">コントロール</h2>

      <section className="control">
        <span className="control__label">プリセット ⟳</span>
        <div className="chips">
          {terrariumPresets.map((preset) => (
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
        {/*
          目盛りは**有効数字 2 桁の値を並べたもの**である。壁の位置が
          DynamoDB は 40,000 WCU、Aurora は 400 q/s と 100 倍離れているので、
          線形だと片方の帯域が 1 目盛りの中に潰れる（loadDial.ts の解説を参照）。
          負荷はテーブルを作り直さないので、動かした端から反映してよい。
        */}
        <input
          id="load"
          type="range"
          min={0}
          max={loadDialMaxPosition(loadMax)}
          step={1}
          value={requestsPerSecToDial(loadValue, loadMax)}
          onChange={(event) => {
            const value = dialToRequestsPerSec(Number(event.target.value), loadMax);
            onLoadChange(isWrite ? { writesPerSecond: value } : { readsPerSecond: value });
          }}
        />
        <p className="note">
          このダイヤルは 1 本しかない。DynamoDB と Aurora へ同じ量が流れる。
          片方だけずらす切り替えは意図的に用意していない（実験が公平でなくなるため）。
          目盛りは桁ごとに細かさが変わるので、400 q/s (Aurora の壁) の前後も
          40,000 WCU (DynamoDB の壁) の前後も同じように刻める。
        </p>
      </section>

      <section className="control">
        <span className="control__label">Aurora インスタンスクラス ⟳</span>
        <div className="chips">
          {AURORA_INSTANCE_CLASS_NAMES.map((name) => (
            <Chip
              key={name}
              on={name === aurora.instanceClass}
              onClick={() => {
                if (name !== aurora.instanceClass) onAuroraChange({ instanceClass: name });
              }}
            >
              {name}
            </Chip>
          ))}
        </div>
        {/*
          ⚠️ 「上げるほど待合室ばかり増える」と書いてはいけない（実際は逆）。
          クラスを上げると窓口は 2 → 32 (16 倍) なのに待合室は 1,000 → 5,000 (5 倍) で、
          比はむしろ 500 倍 → 156 倍へ**改善する**（instanceClasses.ts の表が権威）。
          主題は比の変化ではなく、**どのクラスでも桁が違う**ことのほうである。
        */}
        <p className="note">
          窓口 (vCPU) <b>{AURORA_INSTANCE_CLASSES[aurora.instanceClass].vcpu}</b> 本に対し、
          待合室 (max_connections){' '}
          <b>{number.format(AURORA_INSTANCE_CLASSES[aurora.instanceClass].maxConnections)}</b> 席
          — 並ぶ場所が捌ける本数の{' '}
          <b>
            {number.format(
              Math.round(
                AURORA_INSTANCE_CLASSES[aurora.instanceClass].maxConnections /
                  AURORA_INSTANCE_CLASSES[aurora.instanceClass].vcpu,
              ),
            )}
          </b>{' '}
          倍広い。クラスを上げると窓口は 16 倍 (2 → 32) になるのに待合室は 5 倍 (1,000 → 5,000) で、
          この比は 500 倍 → 156 倍へ縮まる。それでも<b>桁は変わらない</b> — だから
          Aurora はどのクラスでもエラーを出さずに遅くなれる。
          そして「メモリを増やす」より<b>vCPU を増やす</b>ほうが効くことも、この表の形から読める。
        </p>
      </section>

      <section className="control">
        <label className="control__row">
          <input
            type="checkbox"
            checked={aurora.retry !== undefined}
            onChange={(event) => onAuroraChange({ retry: event.target.checked ? DEFAULT_RETRY : undefined })}
          />
          <span>クライアントの再送（増幅）</span>
        </label>
        {/*
          ⚠️ ここに ⟳ を付けてはいけない。再送を切っても待ち行列はリセットされない。
          リセットしてしまうと「増幅を断ち切ったから戻った」が
          「作り直したから戻った」に見えてしまい、メタステーブル障害の因果が壊れる。
        */}
        <p className="note">
          こちらは ⟳ が付かない — 再送はクライアント側の振る舞いなので、
          切ってもサーバに並んでいる客は消えない。負荷を安全域へ戻しても戻らなくなり、
          <b>再送を切って初めて回復する</b>のが観察できる。
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
        ⟳ の項目は作り直しを伴う。DynamoDB 側は経過時間とバーストの貯金が、
        Aurora 側は<b>待ち行列</b>がリセットされる。
        Aurora のクラス変更で行列が消えるのは実機に忠実である —
        インスタンスのスケールはフェイルオーバー（数十秒の断）を伴うので、
        溜まった接続は新しいインスタンスへ引き継がれない。つまり
        <b>障害の最中にスケールして逃げ切ることはできない</b>。
        行列が掃けていく様子を見たいときは、負荷ダイヤルを下げること（そちらは作り直さない）。
      </p>
    </aside>
  );
}
