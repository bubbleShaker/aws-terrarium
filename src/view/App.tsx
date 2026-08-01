import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { Demand, LaneKind } from '../core/sim/demand.js';
import { TerrariumDriver } from '../core/scenario/driver.js';
import { defaultAuroraLiveSettings } from '../core/scenario/aurora/liveSession.js';
import type { DynamoDbLiveSettings } from '../core/scenario/dynamodb/liveSession.js';
import { type DynamoDbLivePreset, defaultDynamoDbLivePreset } from '../core/scenario/dynamodb/livePresets.js';
import { TerrariumScene } from './scene/TerrariumScene.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { StatusHud } from './ui/StatusHud.js';
import { useSimulationDriver } from './useSimulationDriver.js';

/**
 * 画面全体。
 *
 * シミュレーションの真実は `TerrariumDriver` が持ち、React の state は
 * **コントロールの表示値のミラー**でしかない。二重に真実を持つと必ずずれるので、
 * 値を変えるときは必ず driver を先に更新する。
 *
 * ⚠️ 時間と負荷の操作は driver 経由でしか行わない。個々のセッションの時計に
 * 手を伸ばすと、DynamoDB と Aurora の仮想時間がズレて並置の前提が崩れる
 * （そもそもセッションは時計を持っていない）。
 */
export function App(): JSX.Element {
  // useMemo はキャッシュを捨てることが許されている。シミュレーション本体の保持先には使えない。
  const [driver] = useState(
    () =>
      new TerrariumDriver({
        load: defaultDynamoDbLivePreset.load,
        dynamodb: defaultDynamoDbLivePreset.settings,
        aurora: defaultAuroraLiveSettings,
      }),
  );
  const [settings, setSettings] = useState<DynamoDbLiveSettings>(defaultDynamoDbLivePreset.settings);
  const [load, setLoad] = useState<Demand>(defaultDynamoDbLivePreset.load);
  const [presetName, setPresetName] = useState(defaultDynamoDbLivePreset.name);
  const [lesson, setLesson] = useState(defaultDynamoDbLivePreset.lesson);
  const [lane, setLane] = useState<LaneKind>(defaultDynamoDbLivePreset.focusLane);
  const [timeScale, setTimeScale] = useState(1);

  const snapshot = useSimulationDriver(driver);

  useEffect(() => {
    driver.timeScale = timeScale;
  }, [driver, timeScale]);

  const handleChange = useCallback(
    (patch: Partial<DynamoDbLiveSettings>) => {
      driver.dynamodb.update(patch);
      setSettings(driver.dynamodb.settings);
      // プリセットから外れた時点で、表示中の解説は現在の状態を説明していない。
      setPresetName('custom');
      setLesson('プリセットから外れた設定を触っている。数字と柱がどう動くかを見る。');
    },
    [driver],
  );

  // 負荷は 1 本の共有ダイヤル。片方だけに流す経路は用意しない
  // （ずらせないことが「実験が必ず公平である」を保証している）。
  //
  // 設定変更と同じく、動かした時点でプリセットから外れる。プリセットの解説は
  // 「この負荷でこうなる」を語っているので、負荷を変えたら説明として成立しなくなる。
  const handleLoadChange = useCallback(
    (patch: Partial<Demand>) => {
      driver.setLoad(patch);
      setLoad(driver.load);
      setPresetName('custom');
      setLesson('プリセットから外れた負荷を流している。数字と柱がどう動くかを見る。');
    },
    [driver],
  );

  const handleLoadPreset = useCallback(
    (preset: DynamoDbLivePreset) => {
      driver.dynamodb.replace(preset.settings);
      driver.setLoad(preset.load);
      // 設定の出所は driver に一本化する。preset.settings をそのまま入れると、
      // 省略可能なフィールドの扱いが session 側とずれる。
      setSettings(driver.dynamodb.settings);
      setLoad(driver.load);
      setPresetName(preset.name);
      setLesson(preset.lesson);
      setLane(preset.focusLane);
    },
    [driver],
  );

  return (
    <div className="app">
      {/*
        generation は snapshot (10Hz) 経由では最大 100ms 遅れる。
        柱と粒子を作り直す合図なので、session から直接読む。

        Aurora はまだ 3D に出していない (M3 の次の一歩)。
        driver 側では既に同じ時間・同じ負荷で動いている。
      */}
      <TerrariumScene
        session={driver.dynamodb}
        lane={lane}
        generation={driver.dynamodb.generation}
      />
      <StatusHud snapshot={snapshot.dynamodb} lane={lane} lesson={lesson} presetName={presetName} />
      <ControlPanel
        settings={settings}
        load={load}
        lane={lane}
        presetName={presetName}
        timeScale={timeScale}
        onChange={handleChange}
        onLoadChange={handleLoadChange}
        onLoadPreset={handleLoadPreset}
        onLaneChange={setLane}
        onTimeScaleChange={setTimeScale}
      />
    </div>
  );
}
