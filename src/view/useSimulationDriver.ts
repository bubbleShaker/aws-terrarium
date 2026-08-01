import { useEffect, useState } from 'react';
import type { TerrariumDriver, TerrariumSnapshot } from '../core/scenario/driver.js';

/**
 * シミュレーションを実時間で回し、HUD 用のスナップショットを間引いて配る。
 *
 * ## なぜ Canvas の中 (useFrame) ではなく独立した rAF ループなのか
 *
 * HUD (HTML) と 3D の両方がシミュレーションの結果を要るため。
 * useFrame の中で駆動すると HUD へ値を持ち上げる経路が要り、Canvas の外に
 * シミュレーションの一部が漏れる。ここで回しておけば、3D 側は
 * `session.latest` を毎フレーム読むだけの純粋な描画係でいられる。
 *
 * ## なぜスナップショットを間引くのか
 *
 * 毎フレーム `setState` すると 60fps で React の再描画が走り、
 * 柱 50 本ぶんのオブジェクト生成が毎フレーム発生する。
 * HUD の数字は 10Hz もあれば十分読めるので、そこで止める。
 * 3D は React の再描画を経由せず `session.latest` を直接読むので影響を受けない。
 *
 * ## 実時間に触れてよいのはここだけ
 *
 * `performance.now()` から先は `TerrariumDriver` の `SimulationClock` が
 * 固定タイムステップへ均してくれる。Core は実時間を一切知らない。
 */
export function useSimulationDriver(driver: TerrariumDriver, hudHz = 10): TerrariumSnapshot {
  const [snapshot, setSnapshot] = useState<TerrariumSnapshot>(() => driver.snapshot());

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let sinceSnapshot = 0;
    const interval = 1 / Math.max(1, hudHz);

    const loop = (now: number): void => {
      const deltaSeconds = (now - last) / 1000;
      last = now;

      // 1 回の advance で両サービスが同じ tick 数ぶん進む。
      driver.advance(deltaSeconds);

      sinceSnapshot += deltaSeconds;
      if (sinceSnapshot >= interval) {
        sinceSnapshot = 0;
        setSnapshot(driver.snapshot());
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [driver, hudHz]);

  return snapshot;
}
