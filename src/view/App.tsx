import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { Demand, LaneKind } from '../core/sim/demand.js';
import { TerrariumDriver } from '../core/scenario/driver.js';
import type { AuroraLiveSettings } from '../core/scenario/aurora/liveSession.js';
import type { DynamoDbLiveSettings } from '../core/scenario/dynamodb/liveSession.js';
import { type TerrariumPreset, defaultTerrariumPreset } from '../core/scenario/terrariumPresets.js';
import { TerrariumScene } from './scene/TerrariumScene.js';
import { AuroraHud } from './ui/AuroraHud.js';
import { ComparisonHud } from './ui/ComparisonHud.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { StatusHud } from './ui/StatusHud.js';
import { useSimulationDriver } from './useSimulationDriver.js';

/** プリセットから外れたときの表示。設定と負荷で文面を分ける必要は無い。 */
const CUSTOM_LESSON = 'プリセットから外れた状態を触っている。数字と空間がどう動くかを見る。';

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
        load: defaultTerrariumPreset.load,
        dynamodb: defaultTerrariumPreset.dynamodb,
        aurora: defaultTerrariumPreset.aurora,
        // M4-1 時点では画面に出していない（3D と HUD は M4-2）。
        // それでも driver に載せてあるのは、**プリセットが全サービスを同時に戻す**という
        // 不変条件を、描画より先に成立させておくためである。
        sqs: defaultTerrariumPreset.sqs,
      }),
  );
  const [settings, setSettings] = useState<DynamoDbLiveSettings>(defaultTerrariumPreset.dynamodb);
  const [auroraSettings, setAuroraSettings] = useState<AuroraLiveSettings>(
    defaultTerrariumPreset.aurora,
  );
  const [load, setLoad] = useState<Demand>(defaultTerrariumPreset.load);
  const [presetName, setPresetName] = useState(defaultTerrariumPreset.name);
  const [lesson, setLesson] = useState(defaultTerrariumPreset.lesson);
  const [lane, setLane] = useState<LaneKind>(defaultTerrariumPreset.focusLane);
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
      setLesson(CUSTOM_LESSON);
    },
    [driver],
  );

  const handleAuroraChange = useCallback(
    (patch: Partial<AuroraLiveSettings>) => {
      driver.aurora.update(patch);
      setAuroraSettings(driver.aurora.settings);
      setPresetName('custom');
      setLesson(CUSTOM_LESSON);
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
      setLesson(CUSTOM_LESSON);
    },
    [driver],
  );

  // プリセットは**全サービスを同時に**元へ戻す。1 つでも前の状態が残ると、
  // 「同じ負荷を、容量の等しいサービスへ流す」という看板シナリオが静かに崩れる。
  //
  // SQS では**溜まったバックログごと**戻す必要がある。ここを忘れると、
  // 前のシナリオで積み上がった数十万件を抱えたまま次のシナリオが始まり、
  // 「最初から手遅れ」の状態を見せることになる。
  const handleLoadPreset = useCallback(
    (preset: TerrariumPreset) => {
      driver.dynamodb.replace(preset.dynamodb);
      driver.aurora.replace(preset.aurora);
      driver.sqs.replace(preset.sqs);
      driver.setLoad(preset.load);
      // 設定の出所は driver に一本化する。preset をそのまま入れると、
      // 省略可能なフィールドの扱いが session 側とずれる。
      setSettings(driver.dynamodb.settings);
      setAuroraSettings(driver.aurora.settings);
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
        柱・粒子・待合室を作り直す合図なので、session から直接読む。
      */}
      <TerrariumScene
        dynamodb={driver.dynamodb}
        aurora={driver.aurora}
        load={snapshot.load}
        lane={lane}
        dynamoDbGeneration={driver.dynamodb.generation}
        auroraGeneration={driver.aurora.generation}
      />

      <div className="rail rail--left">
        {/*
          看板は画面中央下へ抜き出して表示する (CSS の position: fixed)。
          DOM 上でここに置いてあるのは、中央に置く幅が無い画面で
          そのまま左の列へ畳めるようにするため。
        */}
        <ComparisonHud snapshot={snapshot} lane={lane} />
        <StatusHud snapshot={snapshot.dynamodb} lane={lane} lesson={lesson} presetName={presetName} />
        <AuroraHud snapshot={snapshot.aurora} load={snapshot.load} />
      </div>

      <div className="rail rail--right">
        <ControlPanel
          settings={settings}
          aurora={auroraSettings}
          load={load}
          lane={lane}
          presetName={presetName}
          timeScale={timeScale}
          onChange={handleChange}
          onAuroraChange={handleAuroraChange}
          onLoadChange={handleLoadChange}
          onLoadPreset={handleLoadPreset}
          onLaneChange={setLane}
          onTimeScaleChange={setTimeScale}
        />
      </div>
    </div>
  );
}
