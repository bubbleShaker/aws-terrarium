import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { DynamoDbLiveSession, type LaneKind, type DynamoDbLiveSettings } from '../core/scenario/dynamodb/liveSession.js';
import { type DynamoDbLivePreset, defaultDynamoDbLivePreset } from '../core/scenario/dynamodb/livePresets.js';
import { TerrariumScene } from './scene/TerrariumScene.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { StatusHud } from './ui/StatusHud.js';
import { useSimulationDriver } from './useSimulationDriver.js';

/**
 * 画面全体。
 *
 * シミュレーションの真実は `DynamoDbLiveSession` が持ち、React の state は
 * **コントロールの表示値のミラー**でしかない。二重に真実を持つと必ずずれるので、
 * 値を変えるときは必ず session を先に更新する。
 */
export function App(): JSX.Element {
  // useMemo はキャッシュを捨てることが許されている。シミュレーション本体の保持先には使えない。
  const [session] = useState(() => new DynamoDbLiveSession(defaultDynamoDbLivePreset.settings));
  const [settings, setSettings] = useState<DynamoDbLiveSettings>(defaultDynamoDbLivePreset.settings);
  const [presetName, setPresetName] = useState(defaultDynamoDbLivePreset.name);
  const [lesson, setLesson] = useState(defaultDynamoDbLivePreset.lesson);
  const [lane, setLane] = useState<LaneKind>(defaultDynamoDbLivePreset.focusLane);
  const [timeScale, setTimeScale] = useState(1);

  const snapshot = useSimulationDriver(session);

  useEffect(() => {
    session.clock.timeScale = timeScale;
  }, [session, timeScale]);

  const handleChange = useCallback(
    (patch: Partial<DynamoDbLiveSettings>) => {
      session.update(patch);
      setSettings(session.settings);
      // プリセットから外れた時点で、表示中の解説は現在の状態を説明していない。
      setPresetName('custom');
      setLesson('プリセットから外れた設定を触っている。数字と柱がどう動くかを見る。');
    },
    [session],
  );

  const handleLoadPreset = useCallback(
    (preset: DynamoDbLivePreset) => {
      session.replace(preset.settings);
      // 設定の出所は session に一本化する。preset.settings をそのまま入れると、
      // 省略可能なフィールドの扱いが session 側とずれる。
      setSettings(session.settings);
      setPresetName(preset.name);
      setLesson(preset.lesson);
      setLane(preset.focusLane);
    },
    [session],
  );

  return (
    <div className="app">
      {/*
        generation は snapshot (10Hz) 経由では最大 100ms 遅れる。
        柱と粒子を作り直す合図なので、session から直接読む。
      */}
      <TerrariumScene session={session} lane={lane} generation={session.generation} />
      <StatusHud snapshot={snapshot} lane={lane} lesson={lesson} presetName={presetName} />
      <ControlPanel
        settings={settings}
        lane={lane}
        presetName={presetName}
        timeScale={timeScale}
        onChange={handleChange}
        onLoadPreset={handleLoadPreset}
        onLaneChange={setLane}
        onTimeScaleChange={setTimeScale}
      />
    </div>
  );
}
