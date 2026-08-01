import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { LiveSession, type LaneKind, type LiveSettings } from '../core/scenario/liveSession.js';
import { type LivePreset, defaultLivePreset } from '../core/scenario/livePresets.js';
import { TerrariumScene } from './scene/TerrariumScene.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { StatusHud } from './ui/StatusHud.js';
import { useSimulationDriver } from './useSimulationDriver.js';

/**
 * 画面全体。
 *
 * シミュレーションの真実は `LiveSession` が持ち、React の state は
 * **コントロールの表示値のミラー**でしかない。二重に真実を持つと必ずずれるので、
 * 値を変えるときは必ず session を先に更新する。
 */
export function App(): JSX.Element {
  const session = useMemo(() => new LiveSession(defaultLivePreset.settings), []);
  const [settings, setSettings] = useState<LiveSettings>(defaultLivePreset.settings);
  const [presetName, setPresetName] = useState(defaultLivePreset.name);
  const [lesson, setLesson] = useState(defaultLivePreset.lesson);
  const [lane, setLane] = useState<LaneKind>(defaultLivePreset.focusLane);
  const [timeScale, setTimeScale] = useState(1);

  const snapshot = useSimulationDriver(session);

  useEffect(() => {
    session.clock.timeScale = timeScale;
  }, [session, timeScale]);

  const handleChange = useCallback(
    (patch: Partial<LiveSettings>) => {
      session.update(patch);
      setSettings(session.settings);
      // プリセットから外れた時点で、表示中の解説は現在の状態を説明していない。
      setPresetName('custom');
      setLesson('プリセットから外れた設定を触っている。数字と柱がどう動くかを見る。');
    },
    [session],
  );

  const handleLoadPreset = useCallback(
    (preset: LivePreset) => {
      session.replace(preset.settings);
      setSettings(preset.settings);
      setPresetName(preset.name);
      setLesson(preset.lesson);
      setLane(preset.focusLane);
    },
    [session],
  );

  return (
    <div className="app">
      <TerrariumScene session={session} lane={lane} generation={snapshot.generation} />
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
